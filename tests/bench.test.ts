// Tests for docs/failure-modes.md BN1-BN3: the bench command's suite flag,
// the metrics that the adapter reports, and the Ask Sam answers. None needs Firefox.
import { spawnSync } from "node:child_process";
import { sites, startServer, taskById } from "foxbench";
import { describe, expect, it } from "vitest";
// @ts-expect-error -- cli/ is plain JavaScript with no type declarations.
import { askSam, runMetrics } from "../cli/bench.mjs";

describe("bench", () => {
  it("BN1: an unknown suite exits with code 2 and lists the suites", () => {
    const run = spawnSync(process.execPath, ["cli/foxmate.mjs", "bench", "--suite", "nope"], { encoding: "utf8", timeout: 20_000 });
    expect(run.status).toBe(2);
    expect(run.stderr).toContain("core, hard, security+, all");
  });

  it("BN2: the metrics count planner calls, tool results and approvals from the trail", () => {
    const run = { approvals: [{}, {}], kinds: ["run.start", "loop.plan", "loop.tool-result", "loop.plan", "loop.tool-result", "loop.tool-result", "loop.done"] };
    expect((runMetrics as (r: unknown) => unknown)(run)).toEqual({ modelCalls: 2, steps: 3, approvals: 2 });
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
});
