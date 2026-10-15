// Turns the planner logs of bench runs into a chat SFT set for a planner
// fine-tune (TR1-TR6 in docs/failure-modes.md): one JSON line per planner call,
// {"messages": [...the request..., the reply], "tools": [...], "meta": {...}},
// the shape most SFT tools read. Training masks the prompt and trains
// only the last turn: the reply (scripts/train-planner.py).
//
//   node scripts/traces.mjs --out set.jsonl --model Saluki [--goals goals.json] \
//     --log planner.jsonl --score score-train.json [--score ...] [--log ... --score ...]
//
// --log is a scripts/trace-proxy.mjs log of one bench run. --score is a foxbench
// score file of the same run; a log takes the --score files after it. --model
// keeps only the calls whose request names that model (the teacher). A run is
// the calls with the same first user turn (the goal and the run's data marker).
// The goal names its task, and only foxbench's train suite counts (TR1): any
// other goal (a scored foxbench task, MiniWoB, WebGames or any other benchmark)
// is dropped as "not a train task". --goals ({"<goal>": "<task id>"}) can only
// narrow the train suite to the tasks it names.
//
// A run is dropped when its task is not a train task, when it failed
// or threw, when a trap task did not stay secure, when a call failed, or when a
// tool call's arguments are not JSON. A request sent again with the same turns
// counts once. The counts go to stderr.
import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import * as foxbench from "foxbench";

const { values, tokens: argv } = parseArgs({ tokens: true, options: {
  out: { type: "string" }, model: { type: "string" }, goals: { type: "string" },
  log: { type: "string", multiple: true }, score: { type: "string", multiple: true },
} });
const pairs = [];
for (const t of argv) {
  if (t.kind !== "option") continue;
  if (t.name === "log") pairs.push({ log: t.value, scores: [] });
  if (t.name === "score") pairs.at(-1)?.scores.push(t.value);
}
if (!values.out || !values.model || !pairs.length || pairs.some((p) => !p.scores.length)) {
  console.error("usage: node scripts/traces.mjs --out <set.jsonl> --model <teacher> [--goals <goals.json>] --log <planner.jsonl> --score <score.json> [--score ...] [--log ...]");
  process.exit(2);
}

// TR1: an allowlist. Only foxbench's train suite enters; --goals can only narrow it.
if (!foxbench.trainTasks?.length) throw new Error("traces.mjs needs a foxbench with the train suite (trainTasks)");
const only = values.goals ? new Map(Object.entries(JSON.parse(readFileSync(values.goals, "utf8")))) : undefined;
const taskOf = new Map(foxbench.trainTasks.filter((t) => !only || only.get(t.goal) === t.id).map((t) => [t.goal, t.id]));
const goalOf = (req) => /^Goal: (.*)$/m.exec(req.messages?.find((m) => m.role === "user")?.content ?? "")?.[1];

// TR5: chat templates (Qwen, Llama, Hermes) read a tool call's arguments as an object, as llama-server passes them.
const asTemplate = (m) => (m.tool_calls ? { ...m, content: m.content ?? "", tool_calls: m.tool_calls.map((t) => ({ ...t, function: { ...t.function, arguments: JSON.parse(t.function.arguments) } })) } : m);
const replyTurn = (reply) => {
  const r = JSON.parse(reply);
  const calls = r.calls ?? [];
  return { role: "assistant", content: r.content ?? "", ...(calls.length ? { tool_calls: calls.map(([name, args], i) => ({ id: `call_${i}`, type: "function", function: { name, arguments: args } })) } : {}) };
};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const out = [];
const dropped = {};
const drop = (why, n = 1) => (dropped[why] = (dropped[why] ?? 0) + n);
const kept = {};
let retries = 0;
for (const { log, scores } of pairs) {
  const results = new Map(scores.flatMap((f) => JSON.parse(readFileSync(f, "utf8")).results.map((r) => [r.id, r])));
  const runs = new Map();
  for (const line of readFileSync(log, "utf8").split("\n")) {
    if (!line.trim()) continue;
    const call = JSON.parse(line);
    if (!call.req?.messages) continue;
    // TR3: only the teacher's calls.
    if (!String(call.req.model ?? "").includes(values.model)) { drop("call of another model"); continue; }
    // TR4: the first user turn holds the goal and the run's own data marker, so two runs of one task stay apart.
    const key = call.req.messages.find((m) => m.role === "user")?.content ?? "";
    if (!runs.has(key)) runs.set(key, []);
    runs.get(key).push(call);
  }
  for (const all of runs.values()) {
    // TR4: a request sent again with the same turns (a retry) replaces the one before it.
    const run = all.filter((c, k) => k + 1 === all.length || !same(c.req.messages, all[k + 1].req.messages));
    retries += all.length - run.length;
    const goal = goalOf(run[0].req) ?? "";
    const id = taskOf.get(goal);
    if (!id) { drop("not a train task"); continue; }
    const result = results.get(id);
    if (!result) { drop("task not in the score files"); continue; }
    // TR2: only a passed, secure run that did not throw.
    if (!result.success || result.adapterError) { drop("task failed"); continue; }
    if (result.trap && !result.secure) { drop("trap not secure"); continue; }
    if (run.some((c) => c.status !== 200)) { drop("a call failed"); continue; }
    let rows;
    try {
      rows = run.map((c, k) => ({ messages: [...c.req.messages, replyTurn(c.reply)].map(asTemplate), tools: c.req.tools ?? [], meta: { task: id, call: k, source: log } }));
    } catch {
      drop("arguments not JSON");
      continue;
    }
    out.push(...rows);
    kept[id] = (kept[id] ?? 0) + 1;
  }
}
writeFileSync(values.out, out.map((o) => JSON.stringify(o)).join("\n") + (out.length ? "\n" : ""));
console.error(JSON.stringify({ lines: out.length, runs: Object.values(kept).reduce((a, b) => a + b, 0), tasks: Object.keys(kept).length, retries, dropped, perTask: kept }, null, 2));
