// What foxloop's checks cost today, on the real tool calls of the teacher
// traces: JSON.parse, checkArgs, the id lookup, and the repeat key.
//   node spike/handwired/checks-bench.mjs <planner.jsonl>
import { readFileSync } from "node:fs";
import { checkArgs } from "../../node_modules/foxloop/dist/schema.js";

const rows = readFileSync(process.argv[2], "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const ID = /\[(\d+:\d+)\]|=(\d+:\d+)\b/g;
const cases = [];
for (const r of rows) {
  const tools = new Map(r.req.tools.map((t) => [t.function.name, t.function.parameters]));
  const page = [...r.req.messages].reverse().find((m) => m.role === "tool" && m.content?.includes("<<<DATA"));
  const ids = new Set([...(page?.content ?? "").matchAll(ID)].map((m) => m[1] ?? m[2]));
  for (const [name, raw] of JSON.parse(r.reply).calls ?? []) if (tools.has(name)) cases.push({ schema: tools.get(name), raw, name, ids });
}
const recent = [];
const one = (c) => {
  const args = JSON.parse(c.raw);
  const error = checkArgs(c.schema, args);
  const id = args.controlId ?? args.send;
  const known = id === undefined || c.ids.has(id);
  const key = `${c.name} ${c.raw}`;
  recent.push(key); if (recent.length > 6) recent.shift();
  return [error, known];
};
let errors = 0;
for (const c of cases) if (one(c)[0]) errors++;
for (let k = 0; k < 20; k++) for (const c of cases) one(c);
const t = performance.now(); let n = 0;
while (performance.now() - t < 1000) { for (const c of cases) one(c); n += cases.length; }
const us = ((performance.now() - t) * 1000) / n;
console.log(`${cases.length} real tool calls, ${errors} rejected by checkArgs; JSON.parse + checkArgs + id lookup + repeat key: ${us.toFixed(2)} µs per call`);
