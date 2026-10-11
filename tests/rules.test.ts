// Tests for docs/failure-modes.md RU1-RU10: foxgate's user rules in
// foxmate's wiring. foxgate, foxloop and foxtrail are real; the tab and the
// tools are stubs.
import { createFoxgate, memoryStore, type Store } from "foxgate";
import type { LoopTool } from "foxloop";
import { Log, MemoryStore, generateKey } from "foxtrail";
import { describe, expect, it } from "vitest";
import { createAgent, type AgentEvent, type RunInput } from "../src/agent.js";
import { createApprovals, ruleOffer } from "../src/approvals.js";

const TABS: Record<number, { url: string }> = {
  1: { url: "http://shop.a.test/cart" },
  2: { url: "http://b.test/cart" },
  3: { url: "http://127.0.0.1:8080/cart" },
  4: { url: "http://shop.a.test/cart" },
};
// The default rule of the public suffix list: the last two labels; no site for an IP address.
const publicSuffix = { getDomain: (h: string) => (/^\d+(\.\d+){3}$/.test(h) ? null : h.split(".").slice(-2).join(".")) };
const host = (tabId: () => number) => async () => new URL(TABS[tabId()]?.url ?? "").hostname;
type Entry = { actor: string; kind: string; data?: unknown };

async function setup(options: { ruleStore?: Store; failTrail?: (e: Entry) => boolean } = {}) {
  const ran: string[] = [];
  const makeTools = (tabId: () => number): LoopTool[] => [
    {
      name: "click", description: "Click a button.", parameters: { type: "object", properties: { button: { type: "string" } }, required: ["button"] }, scope: "submit", domain: host(tabId),
      run: async (args) => { ran.push(`click ${String(args.button)}`); return { ok: true, summary: "Clicked.", check: { ok: true, checks: [{ part: "clicked", ok: true, evidence: "" }] } }; },
    },
  ];
  const log = new Log({ store: new MemoryStore(), key: await generateKey() });
  const entries: Entry[] = [];
  const trail = { append: async (e: Entry) => { if (options.failTrail?.(e)) throw new Error("the trail is full"); entries.push(e); return log.append(e); } };
  const agent = createAgent({
    browser: { tabs: { get: async (id: number) => ({ id, ...TABS[id], cookieStoreId: id === 4 ? "firefox-container-7" : "firefox-default" }) } },
    trail, makeTools, publicSuffix, ruleStore: options.ruleStore ?? memoryStore(),
    loanFor: async (cookieStoreId: string) => (cookieStoreId === "firefox-container-7" ? { cookieStoreId, scope: "submit" as const, domain: "shop.a.test", site: "a.test", state: "active" } : undefined),
    extraTools: [{ tool: { name: "read_inbox", description: "Mail.", parameters: { type: "object", properties: {} }, scope: "read", domain: () => "www.googleapis.com", run: async () => ({ ok: true, summary: "Read 1 message.", untrusted: "Your code is 991177." }) }, domain: "www.googleapis.com", private: true, optIn: true }],
    runMs: 60_000,
  });
  const events: AgentEvent[] = [];
  const run = (input: Partial<RunInput> & { script?: unknown[] }, answer: "approve" | "deny" | "always-allow" = "approve", via = "sidebar") => {
    events.length = 0;
    return agent.run({
      goal: "Buy the mug", tabId: 1, settings: { planner: "scripted", script: JSON.stringify(input.script ?? []) }, ...input,
      onEvent: (event) => {
        events.push(event);
        if (event.type === "approval-needed") {
          void agent.approvals.answer(event.requestId, answer, via).then((r) => {
            if (r !== "decided") void agent.approvals.answer(event.requestId, "deny", "sidebar");
          });
        }
      },
    });
  };
  const asks = () => events.filter((e) => e.type === "approval-needed");
  return { agent, run, ran, events, entries, asks };
}

const click = (button = "Buy") => ({ tool: "click", args: { button } });
const finish = { tool: "finish", args: { summary: "Done." } };

describe("rules", () => {
  it("RU1: Always allow skips the next approval on the site, but not after private data", async () => {
    const { agent, run, ran, asks } = await setup();
    await run({ script: [click("Buy"), finish] }, "always-allow");
    expect(asks()).toHaveLength(1);
    expect(asks()[0]).toMatchObject({ ruleOffer: { site: "a.test", scope: "submit", tool: "click" } });
    expect(await agent.host.rules()).toMatchObject([{ site: "a.test", scope: "submit", tool: "click", effect: "allow" }]);
    expect(await run({ script: [click("Again"), finish] }, "deny")).toMatchObject({ status: "done" });
    expect(asks()).toHaveLength(0);
    // A private run: the rule does not skip the click, and the card makes no offer.
    expect(await run({ allowPrivate: true, script: [{ tool: "read_inbox", args: {} }, click("Leak"), finish] }, "deny")).toMatchObject({ status: "blocked", reason: "approval-denied" });
    expect(asks()).toHaveLength(1);
    expect(asks()[0]).not.toHaveProperty("ruleOffer");
    expect(ran).toEqual(["click Buy", "click Again"]);
  });

  it("RU2: no offer for pay, fill, extra tools or a read on another host; an always-allow answer there decides nothing", async () => {
    const base = { privateRun: false, loan: false, publicSuffix, tabTools: ["click", "open_url", "act"] };
    expect(ruleOffer({ tool: "click", args: {}, domain: "shop.a.test", scope: "submit" }, base)).toEqual({ site: "a.test", scope: "submit", tool: "click" });
    expect(ruleOffer({ tool: "pay", args: {}, domain: "shop.a.test", scope: "pay" }, { ...base, tabTools: ["pay"] })).toBeUndefined();
    expect(ruleOffer({ tool: "act", args: {}, domain: "shop.a.test", scope: "fill" }, base)).toBeUndefined();
    expect(ruleOffer({ tool: "run_python", args: {}, domain: "space.foxmate", scope: "submit" }, base)).toBeUndefined();
    // A fill approval lives on the login gate, whose approvals have no rule offer.
    const { gate, host: fillHost } = createFoxgate({ tools: { "foxvault.fill": "fill" } });
    await fillHost.addGrant({ scope: "fill", domains: ["bank.test"], approval: "always" });
    const fills = createApprovals({ host: fillHost });
    const action = { tool: "foxvault.fill", args: {}, domain: "bank.test", scope: "fill" as const };
    const asked = await gate.check(action);
    if (asked.decision !== "ask") throw new Error("expected ask");
    fills.expect(asked.requestId);
    const token = fills.ask({ step: 1, requestId: asked.requestId, action, expiresAt: asked.expiresAt });
    await new Promise((r) => setTimeout(r, 0));
    expect(await fills.answer(asked.requestId, "always-allow", "sidebar")).toBe("no-rule");
    expect(fills.waiting().map((w) => w.requestId)).toEqual([asked.requestId]);
    await fills.answer(asked.requestId, "deny", "sidebar");
    expect(await token).toBeNull();
  });

  it("RU3: the site is the registrable domain; another site does not match; an IP gets no offer", async () => {
    const { run, asks, ran } = await setup();
    await run({ script: [click("Buy"), finish] }, "always-allow");
    expect(await run({ tabId: 2, script: [click("Other"), finish] }, "deny")).toMatchObject({ status: "blocked", reason: "approval-denied" });
    expect(asks()).toHaveLength(1);
    expect(await run({ tabId: 3, script: [click("Local"), finish] }, "deny")).toMatchObject({ status: "blocked" });
    expect(asks()[0]).not.toHaveProperty("ruleOffer");
    expect(ran).toEqual(["click Buy"]);
  });

  it("RU4: the rule outlives the run, its grants do not", async () => {
    const ruleStore = memoryStore();
    const first = await setup({ ruleStore });
    await first.run({ script: [click("Buy"), finish] }, "always-allow");
    expect(await first.agent.host.grants()).toEqual([]);
    expect(await first.agent.gate.check({ tool: "click", args: { button: "x" }, domain: "shop.a.test", scope: "submit" })).toMatchObject({ decision: "deny", reason: "no-grant" });
    // A restart: a new agent on the same rule store keeps the rule.
    const second = await setup({ ruleStore });
    expect(await second.agent.host.rules()).toHaveLength(1);
    expect(await second.run({ script: [click("Again"), finish] }, "deny")).toMatchObject({ status: "done" });
  });

  it("RU5: a removed rule no longer skips the approval", async () => {
    const { agent, run, asks } = await setup();
    await run({ script: [click("Buy"), finish] }, "always-allow");
    const [rule] = await agent.host.rules();
    expect(await agent.host.removeRule(rule!.id)).toBe(true);
    expect(await run({ script: [click("Again"), finish] }, "deny")).toMatchObject({ status: "blocked", reason: "approval-denied" });
    expect(asks()).toHaveLength(1);
  });

  it("RU6: the trail records rule.add and each decision a rule made, with its ruleId", async () => {
    const { agent, run, entries, events } = await setup();
    await run({ script: [click("Buy"), finish] }, "always-allow");
    const [rule] = await agent.host.rules();
    expect(entries.find((e) => e.kind === "rule.add")).toMatchObject({ actor: "user", data: { ruleId: rule!.id, site: "a.test", scope: "submit", tool: "click", effect: "allow", via: "sidebar" } });
    await run({ script: [click("Again"), finish] });
    expect(entries.filter((e) => e.kind === "gate.rule").map((e) => e.data)).toEqual([expect.objectContaining({ ruleId: rule!.id, decision: "allow", note: `allowed by rule ${rule!.id}` })]);
    expect(events.find((e) => e.type === "rule")).toMatchObject({ ruleId: rule!.id, decision: "allow" });
    const deny = await agent.host.addRule({ site: "a.test", scope: "submit", effect: "deny" });
    expect(await run({ script: [click("No"), finish] })).toMatchObject({ status: "blocked" });
    expect(entries.filter((e) => e.kind === "gate.rule").at(-1)?.data).toMatchObject({ ruleId: deny.id, decision: "deny", note: `denied by rule ${deny.id}` });
  });

  it("RU6: a failed rule.add write adds no rule and approves nothing", async () => {
    const { agent, run, ran } = await setup({ failTrail: (e) => e.kind === "rule.add" });
    expect(await run({ script: [click("Buy"), finish] }, "always-allow")).toMatchObject({ status: "blocked", reason: "approval-denied" });
    expect(await agent.host.rules()).toEqual([]);
    expect(ran).toEqual([]);
  });

  it("RU7: an always-allow answer from the phone decides nothing", async () => {
    const { agent, run, ran } = await setup();
    expect(await run({ script: [click("Buy"), finish] }, "always-allow", "phone")).toMatchObject({ status: "blocked", reason: "approval-denied" });
    expect(await agent.host.rules()).toEqual([]);
    expect(ran).toEqual([]);
  });

  it("RU8: a loan run gets no offer, and an allow rule does not skip its approval", async () => {
    const { agent, run, asks, ran } = await setup();
    await agent.host.addRule({ site: "a.test", scope: "submit", tool: "click", effect: "allow" });
    expect(await run({ tabId: 4, script: [click("Lent"), finish] }, "deny")).toMatchObject({ status: "blocked", reason: "approval-denied" });
    expect(asks()).toHaveLength(1);
    expect(asks()[0]).not.toHaveProperty("ruleOffer");
    expect(ran).toEqual([]);
  });

  it("RU10: addRule fails, so nothing is approved and the request still waits", async () => {
    const broken: Store = { get: async () => undefined, set: async () => { throw new Error("quota"); } };
    const { agent, run, ran } = await setup({ ruleStore: broken });
    let left = -1;
    const end = await agent.run({
      goal: "Buy", tabId: 1, settings: { planner: "scripted", script: JSON.stringify([click("Buy"), finish]) },
      onEvent: (event) => {
        if (event.type !== "approval-needed") return;
        void agent.approvals.answer(event.requestId, "always-allow", "sidebar").then(async (r) => {
          expect(r).toBe("no-rule");
          left = agent.approvals.waiting().length;
          await agent.approvals.answer(event.requestId, "approve", "sidebar");
        });
      },
    });
    expect(end).toMatchObject({ status: "done" });
    expect(left).toBe(1);
    expect(ran).toEqual(["click Buy"]);
    void run;
  });
});
