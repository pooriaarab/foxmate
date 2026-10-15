// The E2E test of `foxmate bench-mcp` (docs/failure-modes.md BM1-BM8). It
// calls the server as an MCP client, on foxbench sites with the scripted
// planner, then runs foxbench's train suite twice through foxbench's own
// CLI: noop must score 0, and foxmate over MCP above 0 with no adapter
// error but a time limit. Usage: pnpm e2e:mcp [-- <bench-mcp planner
// options>]; the default is the saluki planner. FOXKIT_BROWSER=ichabod
// runs it on Ichabod (BM4).
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { writeArtifact } from "create-foxkit/e2e";
import { sites, startServer, taskById } from "foxbench";

const planner = process.argv.slice(2).filter((a) => a !== "--");
const record = { startedAt: new Date().toISOString(), planner, checks: [] };
const check = (name, expected, actual) => record.checks.push({ name, expected, actual, ok: JSON.stringify(actual) === JSON.stringify(expected) });
const env = Object.fromEntries(Object.entries(process.env).filter((e) => e[1] !== undefined));
const secrets = [process.env.ICHABOD_API_KEY, "trycloudflare.com"].filter(Boolean);
const leaks = (text) => secrets.filter((s) => text.includes(s)).length;

async function client(args) {
  const c = new Client({ name: "e2e", version: "0.0.0" });
  const transport = new StdioClientTransport({ command: process.execPath, args: ["cli/foxmate.mjs", "bench-mcp", ...args], env, stderr: "inherit" });
  await c.connect(transport);
  c.pid = transport.pid;
  return c;
}
/** Whether a process is still there `ms` after the check starts. */
async function aliveAfter(pid, ms) {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 250))) {
    try {
      process.kill(pid, 0);
    } catch {
      return false;
    }
  }
  return true;
}
const call = (c, args) => c.callTool({ name: "run_task", arguments: args }, undefined, { timeout: 900_000 });
const text = (reply) => reply.content.map((p) => p.text ?? "").join("\n");

const bench = await startServer({ sites });
try {
  // BM1, BM2, BM5, BM6: the scripted planner on two foxbench tasks, called at once.
  const c = await client(["--planner", "scripted"]);
  check("BM1 the server lists one tool, run_task", ["run_task"], (await c.listTools()).tools.map((t) => t.name));
  check("BM2 a file: url is a tool error", true, (await call(c, { url: "file:///etc/passwd", goal: "Read it." })).isError === true);
  check("BM2 a missing goal is a tool error", true, (await call(c, { url: bench.url })).isError === true);
  const urls = ["flights-oneway", "flights-return"].map((id) => [bench.reset(taskById(id)), taskById(id).goal]);
  const [one, two] = await Promise.all(urls.map(async ([url, goal]) => ({ reply: JSON.parse(text(await call(c, { url, goal }))) })));
  check("BM5 two calls at once both end done", [true, true], [one.reply.done, two.reply.done]);
  check("BM6 a done reply has its finish summary as answer", true, typeof two.reply.answer === "string" && two.reply.answer.length > 0);
  check("BM6 metrics count the planner calls", true, one.reply.metrics.modelCalls > 0);
  await c.close();
  check("BM7 the server exits within 15 s of a closed stdin", false, await aliveAfter(c.pid, 15_000));

  // BM3: a Firefox that does not start is a tool error, not a failed task.
  if (process.env.FOXKIT_BROWSER !== "ichabod") {
    const broken = await client(["--planner", "scripted", "--firefox", "/nonexistent/firefox"]);
    const reply = await call(broken, { url: bench.reset(taskById("flights-oneway")), goal: taskById("flights-oneway").goal });
    check("BM3 a Firefox that does not start is a tool error", true, reply.isError === true);
    await broken.close();
  }

  // BM8: foxbench's train suite through foxbench's CLI, noop then foxmate.
  const out = mkdtempSync(join(tmpdir(), "bench-mcp-"));
  const foxbench = (agent, dir, more = []) => {
    const run = spawnSync(process.execPath, ["node_modules/foxbench/dist/cli.js", "run", "--agent", agent, "--suite", "foxbench", "--subset", "tag:train", "--out", join(out, dir), ...more], { env, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"], timeout: 4 * 3600_000 });
    const file = readdirSync(join(out, dir)).find((f) => f.endsWith(".json"));
    const board = JSON.parse(readFileSync(join(out, dir, file), "utf8"));
    return { board, leaks: leaks(run.stdout + readFileSync(join(out, dir, file), "utf8")) };
  };
  const noop = foxbench("noop", "noop");
  check("BM8 noop scores 0 on the train suite", { rate: 0, tasks: true }, { rate: noop.board.successRate, tasks: noop.board.tasks > 0 });
  const fox = foxbench("mcp", "foxmate", ["--name", "foxmate", "--", process.execPath, "cli/foxmate.mjs", "bench-mcp", ...planner]);
  record.train = { tasks: fox.board.tasks, successRate: fox.board.successRate, adapterErrors: fox.board.adapterErrors };
  check("BM8 foxmate scores above 0 on the train suite", true, fox.board.successRate > 0);
  // A task over its time limit is an adapter error to foxbench, but foxmate ran it.
  const setupErrors = fox.board.results.filter((r) => r.adapterError && !(r.log ?? "").startsWith("adapter error: timed out")).map((r) => r.id);
  check("BM3 foxmate has no adapter error but a time limit on the train suite", [], setupErrors);
  check("BM4 no key, gate or tunnel host in the score", 0, fox.leaks);
} catch (error) {
  record.error = error instanceof Error ? error.stack : String(error);
} finally {
  await bench.close();
}
record.passed = !record.error && record.checks.length > 0 && record.checks.every((c) => c.ok);
const path = writeArtifact("artifacts", "e2e-bench-mcp", record);
for (const c of record.checks) console.log(`${c.ok ? "ok " : "BAD"} ${c.name}: ${JSON.stringify(c.actual)}`);
console.log(`${record.passed ? "PASS" : "FAIL"}${record.error ? `: ${record.error}` : ""} | ${path}`);
process.exitCode = record.passed ? 0 : 1;
