// Tests for docs/failure-modes.md TR1-TR6: scripts/traces.mjs on proxy logs and
// score files written here. None needs a model or Firefox.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tasks } from "foxbench";
import { describe, expect, it } from "vitest";

const TEACHER = "Underdog-Saluki-27B-1.0-IQ2-mix.gguf";
const SYSTEM = { role: "system", content: "You plan the steps of a browser agent." };
const TOOLS = [{ type: "function", function: { name: "click", parameters: { type: "object" } } }];
const user = (goal: string, marker: string) => ({ role: "user", content: `Goal: ${goal}\n\nThe data marker of this run: <<<DATA ${marker}>>> ... <<<END ${marker}>>>` });
const asked = (name: string, args: string) => ({ role: "assistant", content: "", tool_calls: [{ id: "c0", type: "function", function: { name, arguments: args } }] });
const result = (text: string) => ({ role: "tool", tool_call_id: "c0", content: text });

/** One proxy log line: the request, and the reply as trace-proxy.mjs writes it. */
const line = (messages: object[], reply: [string, string][], over: { model?: string; status?: number } = {}) =>
  JSON.stringify({ at: 0, status: over.status ?? 200, timings: { prompt_n: 10, cache_n: 0, predicted_n: 5 }, reply: JSON.stringify({ content: "", calls: reply }),
    req: { model: over.model ?? TEACHER, messages, tools: TOOLS } });
/** A two-call run: a click, then finish. */
const run = (goal: string, marker: string, over: { model?: string; status?: number; args?: string } = {}) => {
  const first = [SYSTEM, user(goal, marker)];
  const args = over.args ?? '{"controlId":"0:3"}';
  return [line(first, [["click", args]], over), line([...first, asked("click", args), result("click: ok")], [["finish", '{"summary":"Done"}']], over)];
};

function traces(logLines: string[], results: object[], goals: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), "traces-"));
  writeFileSync(join(dir, "planner.jsonl"), `${logLines.join("\n")}\n`);
  writeFileSync(join(dir, "score.json"), JSON.stringify({ results }));
  writeFileSync(join(dir, "goals.json"), JSON.stringify(goals));
  const out = join(dir, "set.jsonl");
  const cli = spawnSync(process.execPath, ["scripts/traces.mjs", "--out", out, "--model", "Saluki", "--goals", join(dir, "goals.json"),
    "--log", join(dir, "planner.jsonl"), "--score", join(dir, "score.json")], { encoding: "utf8", timeout: 20_000 });
  expect(cli.status, cli.stderr).toBe(0);
  const rows = readFileSync(out, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  return { rows, report: JSON.parse(cli.stderr) };
}
const pass = (id: string, over: object = {}) => ({ id, success: true, adapterError: false, trap: null, secure: true, ...over });
const GOAL = "Book a Standard room at StayNest.";

describe("traces", () => {
  it("TR1: a run of a scored task is dropped, even when --goals names it", () => {
    const core = tasks.find((t) => t.suite === "core")!;
    const { rows, report } = traces([...run(core.goal, "a1"), ...run(GOAL, "a2")], [pass(core.id), pass("stay-1")], { [core.goal]: core.id, [GOAL]: "stay-1" });
    expect(rows.map((r) => r.meta.task)).toEqual(["stay-1", "stay-1"]);
    expect(report.dropped).toEqual({ "run of a scored task": 1 });
  });

  it("TR2: a failed run, a run that threw, an obeyed trap and a failed call are dropped", () => {
    const goals = { "Goal one.": "t-1", "Goal two.": "t-2", "Goal three.": "t-3", "Goal four.": "t-4", [GOAL]: "t-5" };
    const { rows, report } = traces([...run("Goal one.", "b1"), ...run("Goal two.", "b2"), ...run("Goal three.", "b3"), ...run("Goal four.", "b4", { status: 500 }), ...run(GOAL, "b5")],
      [pass("t-1", { success: false }), pass("t-2", { adapterError: true }), pass("t-3", { trap: "x", secure: false }), pass("t-4"), pass("t-5", { trap: "x", secure: true })], goals);
    expect(new Set(rows.map((r) => r.meta.task))).toEqual(new Set(["t-5"]));
    expect(report.dropped).toEqual({ "task failed": 2, "trap not secure": 1, "a call failed": 1 });
  });

  it("TR3: calls of another model are dropped", () => {
    const { rows, report } = traces([...run(GOAL, "c1", { model: "Qwen3.5-4B" }), ...run(GOAL, "c2")], [pass("t-1")], { [GOAL]: "t-1" });
    expect(rows).toHaveLength(2);
    expect(report.dropped).toEqual({ "call of another model": 2 });
  });

  it("TR4: two runs of one task stay apart, and a retried request counts once", () => {
    const [a, b] = run(GOAL, "d1");
    const { rows, report } = traces([a!, a!, b!, ...run(GOAL, "d2")], [pass("t-1")], { [GOAL]: "t-1" });
    expect(rows).toHaveLength(4);
    expect(report.retries).toBe(1);
    expect(report.perTask).toEqual({ "t-1": 2 });
  });

  it("TR5: arguments become objects, and a run with arguments that are not JSON is dropped", () => {
    const { rows, report } = traces([...run(GOAL, "e1"), ...run("Goal two.", "e2", { args: "{not json" })], [pass("t-1"), pass("t-2")], { [GOAL]: "t-1", "Goal two.": "t-2" });
    expect(rows[1].messages[2].tool_calls[0].function.arguments).toEqual({ controlId: "0:3" });
    expect(rows[0].messages.at(-1).tool_calls[0].function.arguments).toEqual({ controlId: "0:3" });
    expect(report.dropped).toEqual({ "arguments not JSON": 1 });
  });

  it("TR6: each line is one call's request, then its reply as the last turn", () => {
    const { rows } = traces(run(GOAL, "f1"), [pass("t-1")], { [GOAL]: "t-1" });
    expect(rows.map((r) => r.messages.length)).toEqual([3, 5]);
    expect(rows.map((r) => r.messages.at(-1).role)).toEqual(["assistant", "assistant"]);
    expect(rows[1].messages.at(-1).tool_calls[0].function.name).toBe("finish");
    expect(rows[0].tools).toEqual(TOOLS);
  });
});
