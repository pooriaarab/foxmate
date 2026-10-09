// Tests for docs/failure-modes.md A1-A6, with a real foxgate.
import { createFoxgate } from "foxgate";
import { describe, expect, it } from "vitest";
import { createApprovals } from "../src/approvals.js";

async function setup(now = Date.now) {
  const { gate, host } = createFoxgate({ tools: { click: "submit" }, now, requestTtlMs: 1000 });
  await host.addGrant({ scope: "submit", domains: ["shop.test"] });
  const trail: { actor: string; kind: string; data?: unknown }[] = [];
  const approvals = createApprovals({ host, trail: { append: async (e) => { trail.push(e); } } });
  const ask = async (button: string) => {
    const action = { tool: "click", args: { button }, domain: "shop.test", scope: "submit" as const };
    const decision = await gate.check(action);
    if (decision.decision !== "ask") throw new Error("expected ask");
    // The agent announces each request of its run before it shows it.
    approvals.expect(decision.requestId);
    return { gate, action, request: { step: 1, requestId: decision.requestId, action, expiresAt: Date.now() + 1000 } };
  };
  return { gate, host, approvals, trail, ask };
}

describe("approvals", () => {
  it("A1: an answer decides only the request it names", async () => {
    const { approvals, ask, gate } = await setup();
    const a = await ask("Buy");
    const b = await ask("Send");
    const tokenA = approvals.ask(a.request);
    expect(await approvals.answer(b.request.requestId, "approve", "sidebar")).toBe("decided");
    const tokenB = await approvals.ask(b.request);
    expect(typeof tokenB).toBe("string");
    expect(approvals.waiting().map((w) => w.requestId)).toEqual([a.request.requestId]);
    await approvals.answer(a.request.requestId, "deny", "sidebar");
    expect(await tokenA).toBeNull();
    expect((await gate.redeem(tokenB as string, b.action)).decision).toBe("allow");
  });

  it("A2: the first answer decides; a later one is late", async () => {
    const { approvals, ask, gate } = await setup();
    const a = await ask("Buy");
    const token = approvals.ask(a.request);
    expect(await approvals.answer(a.request.requestId, "approve", "sidebar")).toBe("decided");
    expect(await approvals.answer(a.request.requestId, "deny", "phone")).toBe("late");
    expect((await gate.redeem((await token) as string, a.action)).decision).toBe("allow");
  });

  it("A3: an early answer is kept for its request, if foxgate holds it", async () => {
    const { approvals, ask } = await setup();
    const a = await ask("Buy");
    approvals.expect(a.request.requestId);
    expect(await approvals.answer(a.request.requestId, "approve", "sidebar")).toBe("decided");
    expect(typeof (await approvals.ask(a.request))).toBe("string");
    expect(await approvals.answer("no-such-request", "approve", "sidebar")).toBe("unknown");
  });

  it("A4: with no answer, the request ends as no at its expiry", async () => {
    const { approvals, ask } = await setup();
    const a = await ask("Buy");
    const started = Date.now();
    expect(await approvals.ask({ ...a.request, expiresAt: Date.now() + 300 })).toBeNull();
    expect(Date.now() - started).toBeLessThan(2000);
    expect(approvals.waiting()).toEqual([]);
  });

  it("A5: cancelAll ends every waiting request as no", async () => {
    const { approvals, ask } = await setup();
    const a = approvals.ask((await ask("Buy")).request);
    const b = approvals.ask((await ask("Send")).request);
    approvals.cancelAll();
    expect(await a).toBeNull();
    expect(await b).toBeNull();
  });

  it("A6: each deciding answer goes to the trail", async () => {
    const { approvals, ask, trail } = await setup();
    const a = await ask("Buy");
    const token = approvals.ask(a.request);
    await approvals.answer(a.request.requestId, "approve", "phone");
    await token;
    expect(trail).toEqual([{ actor: "user", kind: "approval.answer", data: { requestId: a.request.requestId, decision: "approve", via: "phone" } }]);
  });

  it("waiting() shows foxgate's exact text for each request", async () => {
    const { approvals, ask, host } = await setup();
    const a = await ask("Buy");
    void approvals.ask({ ...a.request, detail: "click the button \"Buy\"" });
    await new Promise((r) => setTimeout(r, 10));
    const [shown] = approvals.waiting();
    expect(shown?.text).toBe((await host.pending())[0]?.text);
    expect(shown?.detail).toBe("click the button \"Buy\"");
    approvals.cancelAll();
  });

  it("A7: an answer after the run ended approves nothing, and foxgate forgets the request", async () => {
    const { approvals, ask, host } = await setup();
    const a = await ask("Buy");
    approvals.expect(a.request.requestId);
    const pending = approvals.ask(a.request);
    approvals.cancelAll();
    expect(await pending).toBeNull();
    expect(await approvals.answer(a.request.requestId, "approve", "phone")).toBe("unknown");
    await new Promise((r) => setTimeout(r, 10));
    expect((await host.pending()).map((r) => r.id)).not.toContain(a.request.requestId);
  });
});
