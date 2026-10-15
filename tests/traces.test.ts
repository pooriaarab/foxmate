// Tests for docs/failure-modes.md TR1-TR6: scripts/traces.mjs on proxy logs and
// score files written here. None needs a model or Firefox.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as foxbench from "foxbench";
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

/** The goals of five train-suite tasks (TR1 allows only these). */
const T = (foxbench as unknown as { trainTasks: { id: string; goal: string }[] }).trainTasks.slice(0, 5);

function traces(logLines: string[], results: object[], goals?: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), "traces-"));
  writeFileSync(join(dir, "planner.jsonl"), `${logLines.join("\n")}\n`);
  writeFileSync(join(dir, "score.json"), JSON.stringify({ results }));
  if (goals) writeFileSync(join(dir, "goals.json"), JSON.stringify(goals));
  const out = join(dir, "set.jsonl");
  const cli = spawnSync(process.execPath, ["scripts/traces.mjs", "--out", out, "--model", "Saluki", ...(goals ? ["--goals", join(dir, "goals.json")] : []),
    "--log", join(dir, "planner.jsonl"), "--score", join(dir, "score.json")], { encoding: "utf8", timeout: 20_000 });
  expect(cli.status, cli.stderr).toBe(0);
  const rows = readFileSync(out, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  return { rows, report: JSON.parse(cli.stderr) };
}
const pass = (id: string, over: object = {}) => ({ id, success: true, adapterError: false, trap: null, secure: true, ...over });


describe("traces", () => {
  it("TR1: only a train-suite goal enters; a scored, a MiniWoB and a made-up goal are dropped, even when --goals names them", () => {
    const core = foxbench.tasks.find((t) => t.suite === "core")!;
    const miniwob = "Click the button labelled Submit.";
    const made = "Book a table for two at Luigi's.";
    const all = traces([...run(core.goal, "a1"), ...run(miniwob, "a2"), ...run(made, "a3"), ...run(T[0]!.goal, "a4")],
      [pass(core.id), pass("click-button#5000"), pass("made-1"), pass(T[0]!.id)], { [core.goal]: core.id, [miniwob]: "click-button#5000", [made]: "made-1", [T[0]!.goal]: T[0]!.id });
    expect(all.rows.map((r) => r.meta.task)).toEqual([T[0]!.id, T[0]!.id]);
    expect(all.report.dropped).toEqual({ "not a train task": 3 });
    // --goals narrows the train suite: a train task it does not name is dropped too.
    const narrow = traces([...run(T[0]!.goal, "b1"), ...run(T[1]!.goal, "b2")], [pass(T[0]!.id), pass(T[1]!.id)], { [T[1]!.goal]: T[1]!.id });
    expect(narrow.rows.map((r) => r.meta.task)).toEqual([T[1]!.id, T[1]!.id]);
    expect(narrow.report.dropped).toEqual({ "not a train task": 1 });
  });

  it("TR2: a failed run, a run that threw, an obeyed trap and a failed call are dropped", () => {
    const { rows, report } = traces([...run(T[0]!.goal, "c1"), ...run(T[1]!.goal, "c2"), ...run(T[2]!.goal, "c3"), ...run(T[3]!.goal, "c4", { status: 500 }), ...run(T[4]!.goal, "c5")],
      [pass(T[0]!.id, { success: false }), pass(T[1]!.id, { adapterError: true }), pass(T[2]!.id, { trap: "x", secure: false }), pass(T[3]!.id), pass(T[4]!.id, { trap: "x", secure: true })]);
    expect(new Set(rows.map((r) => r.meta.task))).toEqual(new Set([T[4]!.id]));
    expect(report.dropped).toEqual({ "task failed": 2, "trap not secure": 1, "a call failed": 1 });
  });

  it("TR3: calls of another model are dropped", () => {
    const { rows, report } = traces([...run(T[0]!.goal, "d1", { model: "Qwen3.5-4B" }), ...run(T[0]!.goal, "d2")], [pass(T[0]!.id)]);
    expect(rows).toHaveLength(2);
    expect(report.dropped).toEqual({ "call of another model": 2 });
  });

  it("TR4: two runs of one task stay apart, and a retried request counts once", () => {
    const [a, b] = run(T[0]!.goal, "e1");
    const { rows, report } = traces([a!, a!, b!, ...run(T[0]!.goal, "e2")], [pass(T[0]!.id)]);
    expect(rows).toHaveLength(4);
    expect(report.retries).toBe(1);
    expect(report.perTask).toEqual({ [T[0]!.id]: 2 });
  });

  it("TR5: arguments become objects, and a run with arguments that are not JSON is dropped", () => {
    const { rows, report } = traces([...run(T[0]!.goal, "f1"), ...run(T[1]!.goal, "f2", { args: "{not json" })], [pass(T[0]!.id), pass(T[1]!.id)]);
    expect(rows[1].messages[2].tool_calls[0].function.arguments).toEqual({ controlId: "0:3" });
    expect(rows[0].messages.at(-1).tool_calls[0].function.arguments).toEqual({ controlId: "0:3" });
    expect(report.dropped).toEqual({ "arguments not JSON": 1 });
  });

  it("TR6: each line is one call's request, then its reply as the last turn", () => {
    const { rows } = traces(run(T[0]!.goal, "g1"), [pass(T[0]!.id)]);
    expect(rows.map((r) => r.messages.length)).toEqual([3, 5]);
    expect(rows.map((r) => r.messages.at(-1).role)).toEqual(["assistant", "assistant"]);
    expect(rows[1].messages.at(-1).tool_calls[0].function.name).toBe("finish");
    expect(rows[0].tools).toEqual(TOOLS);
  });
});
