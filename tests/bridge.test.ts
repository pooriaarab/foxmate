// Tests for docs/failure-modes.md BR2-BR6: one call from an outside agent
// runs through the agent. Only the tab and the tools are stubs.
import { createMemory, memoryStore } from "foxmemory";
import type { LoopTool } from "foxloop";
import { Log, MemoryStore, generateKey } from "foxtrail";
import { describe, expect, it } from "vitest";
import { createAgent, type AgentEvent } from "../src/agent.js";
import { bridgeCall } from "../src/bridge.js";

async function setup() {
  const ran: string[] = [];
  const tool = (name: string, scope: LoopTool["scope"], untrusted?: string): LoopTool => ({
    name, description: name, parameters: { type: "object", properties: { url: { type: "string" } } }, scope,
    domain: (args) => (typeof args.url === "string" ? new URL(args.url).hostname : "shop.test"),
    run: async () => { ran.push(name); return { ok: true, summary: `${name} ran.`, ...(untrusted ? { untrusted } : {}) }; },
  });
  const memory = createMemory({ store: memoryStore(), embedder: { embed: async (texts) => ({ model: "m", vectors: texts.map(() => [1, 0]) }) } });
  await memory.remember("My card ends in 4242.", { kind: "fact" });
  const agent = createAgent({
    browser: { tabs: { get: async (id: number) => ({ id, url: "https://shop.test/cart" }) } },
    trail: new Log({ store: new MemoryStore(), key: await generateKey() }),
    memory,
    makeTools: () => [tool("snapshot", "read", "Cart: 1 mug."), tool("click", "submit"), tool("open_url", "read")],
    pageProblem: async () => undefined,
    runMs: 60_000,
  });
  const events: AgentEvent[] = [];
  const call = (name: string, args: Record<string, unknown> = {}, answer: "approve" | "deny" = "approve") => bridgeCall((mind, onEvent) => agent.run({
    goal: `An outside agent: ${name}`, tabId: 1, settings: {}, mind,
    onEvent: (event) => {
      events.push(event);
      onEvent(event);
      if (event.type === "approval-needed") void agent.approvals.answer(event.requestId, answer, "sidebar");
    },
  }), { name, args });
  return { call, ran, events, agent };
}

describe("bridge", () => {
  it("BR2: a click from the agent waits for the approval in the agent's own path, on the tab's host", async () => {
    const { call, ran, events } = await setup();
    expect(await call("click")).toMatchObject({ ok: true, summary: "click ran." });
    expect(events.find((e) => e.type === "approval-needed")).toMatchObject({ action: { tool: "click", domain: "shop.test", scope: "submit" } });
    expect(ran).toEqual(["click"]);
  });

  it("BR3: a call to another host is denied, and nothing runs", async () => {
    const { call, ran } = await setup();
    await expect(call("open_url", { url: "https://evil.test/" })).rejects.toMatchObject({ code: "denied" });
    expect(ran).toEqual([]);
  });

  it("BR4: the reply holds the page text between the planner's data marks", async () => {
    const { call } = await setup();
    const reply = await call("snapshot");
    expect(reply.summary).toBe("snapshot ran.");
    expect(reply.untrusted).toMatch(/<<<DATA (\w+)>>>\nCart: 1 mug\.\n<<<END \1>>>/);
  });

  it("BR5: a bridge run recalls no memories", async () => {
    const { call, events } = await setup();
    await call("snapshot");
    expect(events.filter((e) => e.type === "recall" || e.type === "private")).toEqual([]);
  });

  it("BR6: a denied approval reaches the agent as approval-denied, and nothing runs", async () => {
    const { call, ran } = await setup();
    await expect(call("click", {}, "deny")).rejects.toMatchObject({ code: "approval-denied" });
    expect(ran).toEqual([]);
  });
});
