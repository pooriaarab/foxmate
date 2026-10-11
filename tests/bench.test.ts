// Tests for docs/failure-modes.md BN1-BN2: the bench command's suite flag and
// the metrics that the adapter reports. Neither needs Firefox.
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
// @ts-expect-error -- cli/ is plain JavaScript with no type declarations.
import { runMetrics } from "../cli/bench.mjs";

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
});
