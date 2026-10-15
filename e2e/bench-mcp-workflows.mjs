// The E2E test of `foxmate bench-mcp --workflows` (docs/failure-modes.md
// WF28). Two bench-mcp processes, so two Firefox profiles, run the same
// foxbench task on one fixed port with the scripted planner. The second
// run must replay the kept steps; a corrupt file must end the command.
// Usage: pnpm e2e:mcp-workflows
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { writeArtifact } from "create-foxkit/e2e";
import { sites, startServer, taskById } from "foxbench";

const PORT = Number(process.env.WF_PORT ?? 18_431);
const task = taskById("flights-oneway");
const record = { startedAt: new Date().toISOString(), checks: [] };
const check = (name, expected, actual) => record.checks.push({ name, expected, actual, ok: JSON.stringify(actual) === JSON.stringify(expected) });
const env = Object.fromEntries(Object.entries(process.env).filter((e) => e[1] !== undefined));
const dir = mkdtempSync(join(tmpdir(), "bench-wf-"));
const file = join(dir, "workflows.json");
const args = ["cli/foxmate.mjs", "bench-mcp", "--planner", "scripted", "--workflows", file];

/** One bench-mcp process, one task, then the process ends: the profile is gone. */
async function runOnce(url) {
  const c = new Client({ name: "e2e", version: "0.0.0" });
  await c.connect(new StdioClientTransport({ command: process.execPath, args, env, stderr: "inherit" }));
  try {
    const reply = await c.callTool({ name: "run_task", arguments: { url, goal: task.goal } }, undefined, { timeout: 600_000 });
    return JSON.parse(reply.content.map((p) => p.text ?? "").join("\n"));
  } finally {
    await c.close();
  }
}

const bench = await startServer({ sites, port: PORT });
try {
  const first = await runOnce(bench.reset(task));
  const second = await runOnce(bench.reset(task));
  record.runs = [first.metrics, second.metrics];
  check("WF28 the first run is done, with no replayed step", { done: true, replayed: 0 }, { done: first.done, replayed: first.metrics.replayed });
  // The scripted planner counts its own steps, so after the replay it starts its script again and the run need not end done; the replayed steps are the claim.
  check("WF28 the second run, in a new Firefox, replays 10 or more steps", true, second.metrics.replayed >= 10);

  writeFileSync(file, "{ not json");
  const bad = spawnSync(process.execPath, args, { env, encoding: "utf8", input: "", timeout: 60_000 });
  check("WF28 a corrupt file ends the command with code 2 and the error", { status: 2, error: true }, { status: bad.status, error: bad.stderr.includes("is not a JSON object of kept workflows") });
} catch (error) {
  record.error = error instanceof Error ? error.stack : String(error);
} finally {
  await bench.close();
}
record.passed = !record.error && record.checks.every((c) => c.ok);
const path = writeArtifact("artifacts", "e2e-bench-mcp-workflows", record);
for (const c of record.checks) console.log(`${c.ok ? "ok " : "BAD"} ${c.name}: ${JSON.stringify(c.actual)}`);
console.log(`${record.passed ? "PASS" : "FAIL"}${record.error ? `: ${record.error}` : ""} | ${path}`);
console.log(`replayed steps, run 1 -> run 2: ${record.runs?.map((m) => `${m.replayed}/${m.steps}`).join(" -> ")}`);
process.exitCode = record.passed ? 0 : 1;
