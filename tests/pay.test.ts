// Tests for docs/failure-modes.md PY1-PY11: payments through foxpay. The paid
// API is foxpay's fake x402 API, so no chain and no money. Only the tab and
// the page read are stubs.
import { memoryStore } from "foxgate";
import type { LoopTool } from "foxloop";
import { x402 } from "foxpay-agent";
import { fakeX402Api } from "foxpay-agent/testing";
import { Log, MemoryStore, generateKey } from "foxtrail";
import { createVault } from "foxvault";
import { describe, expect, it } from "vitest";
import { createAgent, type AgentEvent, type RunInput } from "../src/agent.js";

// A Base Sepolia test key and recipient, from foxpay's README. No real money.
const WALLET = "0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318";
const PAY_TO = "0x209693Bc6afc0C5328bA36FaF03C514EF312287C";
const TABS: Record<number, { url: string; cookieStoreId: string }> = {
  1: { url: "https://bills.test/bill/42", cookieStoreId: "firefox-default" },
  2: { url: "https://bills.test/bill/42", cookieStoreId: "firefox-container-7" },
};
const BILL = "https://bills.test/pay/42";
const finish = { tool: "finish", args: { summary: "Done." } };
const pay = (amount = "0.01", url = BILL) => ({ tool: "pay", args: { url, amount, reason: "Water bill 42" } });

async function setup(cap = 50_000) {
  const api = fakeX402Api({ host: "bills.test", payTo: PAY_TO, price: 10_000, body: "Bill 42 is paid." });
  const vault = createVault();
  await vault.initialize();
  await vault.set("vault:wallet", WALLET, { domains: ["bills.test"] });
  const snapshot: LoopTool = {
    name: "snapshot", description: "Read the page.", parameters: { type: "object", properties: {} }, scope: "read",
    domain: () => "bills.test", run: async () => ({ ok: true, summary: "Read the page.", untrusted: "Amount due: 0.01 USDC." }),
  };
  const agent = createAgent({
    browser: { tabs: { get: async (id: number) => ({ id, ...TABS[id] }) } },
    trail: new Log({ store: new MemoryStore(), key: await generateKey() }),
    makeTools: () => [snapshot],
    loanFor: async (cookieStoreId) => (cookieStoreId === "firefox-container-7" ? { cookieStoreId, scope: "submit", domain: "bills.test", state: "active" } : undefined),
    pageProblem: async () => undefined,
    pay: { x402: x402({ vault, wallet: "vault:wallet", payTo: { "bills.test": PAY_TO }, fetch: api.fetch }), store: memoryStore(), cap: async () => cap },
    runMs: 60_000,
  });
  const events: AgentEvent[] = [];
  const run = (script: unknown[], input: Partial<RunInput> = {}, answer: (e: AgentEvent) => "approve" | "deny" = () => "approve") => agent.run({
    goal: "Pay this bill.", tabId: 1, runKey: "task-1", settings: { planner: "scripted", script: JSON.stringify(script) }, ...input,
    onEvent: (event) => {
      events.push(event);
      if (event.type === "approval-needed") void agent.approvals.answer(event.requestId, answer(event), "sidebar");
    },
  });
  const results = () => events.flatMap((e) => (e.type === "tool-result" && e.name === "pay" ? [e.summary] : []));
  const asks = () => events.filter((e) => e.type === "approval-needed");
  return { api, run, events, results, asks };
}

describe("pay", () => {
  it("PY1: with a cap of 0 the pay tool refuses, and foxpay fetches nothing", async () => {
    const { api, run, results } = await setup(0);
    await run([pay(), finish, finish]);
    expect(results()).toEqual(["Payments are off. The user can set a spending cap in Settings."]);
    expect(api.log).toEqual([]);
  });

  it("PY2: an amount over the cap is refused before any approval", async () => {
    const { api, run, results, asks } = await setup(5_000);
    await run([pay(), finish, finish]);
    expect(results()[0]).toMatch(/^foxpay refused the payment \(spend-cap\)/);
    expect([asks().length, api.settled.length]).toEqual([0, 0]);
  });

  it("PY3, PY5, PY6: the approval shows the exact payment; it pays one time, and a replay pays nothing", async () => {
    const { api, run, results, asks } = await setup();
    const end = await run([pay(), pay(), { tool: "snapshot", args: {} }, finish]);
    expect(end.status).toBe("done");
    const [asked] = asks();
    const text = JSON.parse(String(asked && "exactText" in asked ? asked.exactText : "{}"));
    expect(text).toMatchObject({ tool: "foxpay.pay", scope: "pay", domain: "bills.test", args: { amount: 10_000, currency: "USDC", merchant: "bills.test", payee: `${PAY_TO} on eip155:84532` } });
    expect(asked && "detail" in asked ? asked.detail : "").toBe(`Pay 0.01 USDC to ${PAY_TO} on eip155:84532 on bills.test, for "Water bill 42".`);
    expect(results()).toEqual([`Paid 0.01 USDC to ${PAY_TO} on eip155:84532.`, "This payment already ran (paid). foxmate does not pay it again."]);
    // foxrunner runs the same task again: the same key finds the receipt.
    await run([pay(), finish, finish]);
    expect([asks().length, api.settled.length]).toEqual([1, 1]);
  });

  it("PY4: a wrong amount, or a price that changes after the approval, pays nothing", async () => {
    const { api, run, results } = await setup();
    await run([pay("0.02"), finish, finish]);
    expect(results()[0]).toMatch(/^foxpay refused the payment \(amount-mismatch\)/);
    await run([pay(), finish, finish], { runKey: "task-2" }, () => {
      api.price = 20_000;
      return "approve";
    });
    expect(results()[1]).toMatch(/^foxpay refused the payment \(amount-changed\)/);
    expect(api.settled).toEqual([]);
  });

  it("PY7, PY8: a loan run, or a payment on another host, pays nothing", async () => {
    const { api, run, asks, results, events } = await setup();
    await run([pay(), finish, finish], { tabId: 2 });
    expect(results()).toEqual(["foxmate does not pay on a lent login."]);
    await run([pay("0.01", "https://other.test/pay/42"), finish, finish]);
    expect(events.find((e) => e.type === "decision" && e.decision === "deny")).toMatchObject({ reason: "no-grant" });
    expect([asks().length, api.log.length]).toEqual([0, 0]);
  });

  it("PY10, PY11: a denied payment pays nothing; a paid one makes the run private", async () => {
    const { api, run, results, events } = await setup();
    await run([pay(), finish, finish], {}, () => "deny");
    expect([results(), api.settled]).toEqual([["The user did not approve the payment. Nothing was paid."], []]);
    await run([pay(), finish], { runKey: "task-2" });
    expect(events.find((e) => e.type === "private")).toEqual({ type: "private", source: "pay" });
  });
});
