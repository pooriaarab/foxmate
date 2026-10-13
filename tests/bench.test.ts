// Tests for docs/failure-modes.md BN1-BN3 and BN5: the bench command's suite flag,
// the metrics that the adapter reports, and the Ask Sam answers. None needs Firefox.
import { spawnSync } from "node:child_process";
import { sites, startServer, taskById } from "foxbench";
import { describe, expect, it } from "vitest";
// @ts-expect-error -- cli/ is plain JavaScript with no type declarations.
import { askSam, foxmateAdapter, runMetrics } from "../cli/bench.mjs";

/** A promise that waits until `fail` rejects it: one task's sidebar calls (BN5). */
function gate() {
  let reject: ((error: Error) => void) | undefined;
  const promise = new Promise<never>((_, no) => {
    reject = no;
  });
  promise.catch(() => {});
  return { promise, fail: () => reject?.(new Error("the run ended")) };
}

describe("bench", () => {
  it("BN1: an unknown suite exits with code 2 and lists the suites", () => {
    const run = spawnSync(process.execPath, ["cli/foxmate.mjs", "bench", "--suite", "nope"], { encoding: "utf8", timeout: 20_000 });
    expect(run.status).toBe(2);
    expect(run.stderr).toContain("core, hard, security+, all");
  });

  it("WF8: --replay takes only on or off, before Firefox starts", () => {
    const run = spawnSync(process.execPath, ["cli/foxmate.mjs", "bench", "--replay", "maybe"], { encoding: "utf8", timeout: 20_000 });
    expect(run.status).toBe(2);
    expect(run.stderr).toContain("--replay must be on or off.");
  });

  it("BN2: the metrics count planner calls, tool results and approvals from the trail", () => {
    const run = { approvals: [{}, {}], kinds: ["run.start", "loop.plan", "loop.tool-result", "loop.plan", "loop.tool-result", "loop.tool-result", "loop.done"] };
    expect((runMetrics as (r: unknown) => unknown)(run)).toEqual({ modelCalls: 2, steps: 3, approvals: 2 });
  });

  it("WF8: a replayed step is not a model call", () => {
    const trail = [{ kind: "run.route", data: { by: "replay" } }, { kind: "run.route", data: { by: "replay" } }];
    const run = { approvals: [], kinds: ["loop.plan", "loop.plan", "loop.plan"], trail };
    expect((runMetrics as (r: unknown) => unknown)(run)).toEqual({ modelCalls: 1, steps: 0, approvals: 0 });
  });

  it("BN3: a question goes to Ask Sam on the task's site and comes back with Sam's answer", async () => {
    const server = await startServer({ sites });
    const url = server.reset(taskById("shop-ambiguous-size"));
    const ask = askSam as (url: string, question: string) => Promise<string | undefined>;
    expect(await ask(url, "Which size of the Merino Hoodie do you want?")).toBe("Size L, please.");
    expect(server.state.questions.map((q) => q.text)).toEqual(["Which size of the Merino Hoodie do you want?"]);
    // Sam's newest answer, not the first one.
    expect(await ask(url, "Anything else? <b>&</b>")).toBe("Size L, please.");
    expect(server.state.questions.length).toBe(2);
    await server.close();
    expect(await ask(url, "Are you there?")).toBeUndefined();
  });

  it("BN5: a task that ends after its time limit closes its own tab, not the next task's", async () => {
    type Tab = { url: () => string; closed: boolean; close: () => Promise<void>; bringToFront: () => Promise<void> };
    const tabs: Tab[] = [];
    // Each task's sidebar calls wait until the test lets that task end.
    const gates: { promise: Promise<never>; fail: () => void }[] = [];
    const session = {
      fox: {
        open: async (url: string) => {
          gates.push(gate());
          const tab: Tab = { url: () => url, closed: false, close: async () => { tab.closed = true; }, bringToFront: async () => {} };
          tabs.push(tab);
          return tab;
        },
      },
      // The Stop message answers at once.
      sidebar: { evaluate: async (fn: () => unknown) => (String(fn).includes('"stop"') ? undefined : gates.at(-1)!.promise) },
    };
    const adapter = (foxmateAdapter as (s: unknown, o: unknown) => { runTask(i: { url: string; goal: string }): Promise<unknown>; abort(): Promise<void> })(session, { planner: { planner: "saluki" } });
    const late = adapter.runTask({ url: "http://127.0.0.1:1/a/", goal: "First task" }).catch(() => "late");
    await new Promise((r) => setTimeout(r, 10));
    await adapter.abort();
    const next = adapter.runTask({ url: "http://127.0.0.1:2/b/", goal: "Second task" }).catch(() => "next");
    await new Promise((r) => setTimeout(r, 10));
    gates[0]!.fail();
    expect(await late).toBe("late");
    expect(tabs[0]!.closed).toBe(true);
    expect(tabs[1]!.closed).toBe(false);
    gates[1]!.fail();
    await next;
    expect(tabs[1]!.closed).toBe(true);
  });
});
