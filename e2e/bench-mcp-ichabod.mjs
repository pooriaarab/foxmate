// The Ichabod session checks of `foxmate bench-mcp` (docs/failure-modes.md
// BM9, BM10). BM10 stops a server as foxbench does (SIGTERM, then SIGKILL
// 2 s later) and reads whether Firefox closed first. BM9 takes every free
// Ichabod session, calls run_task, and frees them 150 s later: the call must
// wait and work, not fail. Usage: FOXKIT_BROWSER=ichabod node e2e/bench-mcp-ichabod.mjs
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { writeArtifact } from "create-foxkit/e2e";
import { sites, startServer, taskById } from "foxbench";

const record = { startedAt: new Date().toISOString(), checks: [] };
const check = (name, expected, actual) => record.checks.push({ name, expected, actual, ok: JSON.stringify(actual) === JSON.stringify(expected) });
const env = Object.fromEntries(Object.entries(process.env).filter((e) => e[1] !== undefined));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function client() {
  const c = new Client({ name: "e2e", version: "0.0.0" });
  const transport = new StdioClientTransport({ command: process.execPath, args: ["cli/foxmate.mjs", "bench-mcp", "--planner", "scripted"], env, stderr: "pipe" });
  let stderr = "";
  transport.stderr?.on("data", (chunk) => (stderr += chunk));
  await c.connect(transport);
  return { c, pid: transport.pid, stderr: () => stderr };
}
const run = (c, bench, id) => c.callTool({ name: "run_task", arguments: { url: bench.reset(taskById(id)), goal: taskById(id).goal } }, undefined, { timeout: 900_000 });

/** One raw Ichabod session (BiDi session.new), or undefined when none answers in 12 s. */
function session() {
  const endpoint = `wss://${process.env.ICHABOD_HOST ?? "stage.api.ichabod.nonprod.webservices.mozgcp.net"}/gecko/latest?record_session=false`;
  const ws = new WebSocket(endpoint, { headers: { authorization: `Basic ${Buffer.from(`api:${process.env.ICHABOD_API_KEY}`).toString("base64")}` } });
  return new Promise((done) => {
    const timer = setTimeout(() => (ws.close(), done(undefined)), 12_000);
    ws.addEventListener("open", () => ws.send(JSON.stringify({ id: 1, method: "session.new", params: { capabilities: {} } })));
    ws.addEventListener("message", (e) => {
      if (JSON.parse(String(e.data)).id !== 1) return;
      clearTimeout(timer);
      done(JSON.parse(String(e.data)).result ? ws : (ws.close(), undefined));
    });
    ws.addEventListener("error", () => (clearTimeout(timer), done(undefined)));
  });
}
const endSession = (ws) => new Promise((done) => {
  ws.addEventListener("message", () => (ws.close(), done()));
  ws.send(JSON.stringify({ id: 2, method: "session.end", params: {} }));
  setTimeout(done, 5000);
});

const bench = await startServer({ sites });
try {
  if (process.env.FOXKIT_BROWSER !== "ichabod") throw new Error("Run this test with FOXKIT_BROWSER=ichabod.");
  // BM10: foxbench's stop. Firefox must close within the 2 s before the kill.
  const one = await client();
  check("BM10 a task runs", false, (await run(one.c, bench, "flights-oneway")).isError === true);
  const stopped = Date.now();
  process.kill(one.pid, "SIGTERM");
  await sleep(2000);
  try {
    process.kill(one.pid, "SIGKILL");
  } catch {
    // It exited by itself.
  }
  const closed = /closed Firefox in (\d+) ms/.exec(one.stderr());
  check("BM10 Firefox closed before the kill", true, Boolean(closed) && Number(closed[1]) < Date.now() - stopped);
  record.closeMs = closed ? Number(closed[1]) : null;

  // BM9: every free session taken, then freed 150 s after the call starts: past the 141 s of three 45 s tries.
  await sleep(90_000);
  const held = [];
  for (let ws = await session(); ws && held.length < 8; ws = await session()) held.push(ws);
  record.held = held.length;
  const two = await client();
  const asked = Date.now();
  const free = sleep(150_000).then(() => Promise.all(held.map(endSession)));
  const reply = await run(two.c, bench, "flights-oneway");
  record.callMs = Date.now() - asked;
  record.reply = reply.isError ? reply.content.map((p) => p.text).join("\n").slice(0, 2000) : "ok";
  record.serverLog = two.stderr().split("\n").filter((l) => /bench-mcp:|Ichabod/.test(l)).join("\n").replaceAll(process.env.ICHABOD_API_KEY || "\0", "<key>").slice(-3000);
  await free;
  check("BM9 run_task waits for a free session and works", false, reply.isError === true);
  check("BM9 it waited past the held sessions", true, record.callMs > 150_000);
  await two.c.close();
} catch (error) {
  record.error = error instanceof Error ? error.stack : String(error);
} finally {
  await bench.close();
}
record.passed = !record.error && record.checks.length > 0 && record.checks.every((c) => c.ok);
const path = writeArtifact("artifacts", "e2e-bench-mcp-ichabod", record);
for (const c of record.checks) console.log(`${c.ok ? "ok " : "BAD"} ${c.name}: ${JSON.stringify(c.actual)}`);
console.log(`${record.passed ? "PASS" : "FAIL"}${record.error ? `: ${record.error}` : ""} | ${path}`);
process.exitCode = record.passed ? 0 : 1;
