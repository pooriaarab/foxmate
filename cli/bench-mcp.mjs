// `foxmate bench-mcp`: an MCP server on stdio for `foxbench run --agent mcp`
// (docs/failure-modes.md BM1-BM8). Its one tool, run_task {url, goal}, runs
// one task with the foxmate bench adapter in one Firefox: local, or on
// Ichabod with FOXKIT_BROWSER=ichabod. foxbench scores the task; the reply
// is foxmate's own claim, log, answer and metrics.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { foxmateAdapter } from "./bench.mjs";
import { startFox } from "./driver.mjs";
import { benchExtension, isRemote } from "./remote.mjs";

const TOOL = {
  name: "run_task",
  description: "Runs one browser task with foxmate in Firefox: opens url, works on goal, and returns { done, log, answer?, metrics? }.",
  inputSchema: { type: "object", properties: { url: { type: "string", description: "The http(s) start page." }, goal: { type: "string", description: "The task, in words." } }, required: ["url", "goal"] },
};

const TUNNEL_HOST = /[a-z0-9-]+\.trycloudflare\.com/g;
/** Ichabod had no free session. Its slots free about a minute after a session ends, so the start waits and tries again (BM9). */
const BUSY = /Cannot start an Ichabod session/;
const WAITS = [15_000, 30_000, 60_000];
const START_MS = 5 * 60_000;

async function whenFree(start) {
  const until = Date.now() + START_MS;
  for (let i = 0; ; i++) {
    try {
      return await start();
    } catch (error) {
      const wait = WAITS[Math.min(i, WAITS.length - 1)];
      if (!BUSY.test(error instanceof Error ? error.message : String(error)) || Date.now() + wait > until) throw error;
      console.error(`foxmate bench-mcp: Ichabod has no free session; the next start is in ${wait / 1000} s.`);
      await new Promise((done) => setTimeout(done, wait));
    }
  }
}

export async function serveBenchMcp({ planner, approve, timeoutMs, headless = true, firefox, workflows }) {
  // stdout carries MCP messages only (BM1).
  console.log = console.info = console.debug = console.error;
  const remote = isRemote();
  const start = remote
    ? () => whenFree(() => startFox({ headless, extension: benchExtension(), ...(firefox ? { firefox } : {}), connectTimeoutMs: 30_000 }))
    : () => startFox({ headless, ...(firefox ? { firefox } : {}) });
  let opened;
  // A failed start is forgotten, so the next call tries again (BM3).
  // A temporary profile ends with Firefox, and the kept workflows with it. With a file, they outlive it, so a second run replays (WF28).
  // A file that does not parse ends the command before Firefox starts: no empty start.
  let kept;
  if (workflows && existsSync(workflows)) {
    try {
      kept = JSON.parse(readFileSync(workflows, "utf8"));
      if (!kept || typeof kept !== "object" || Array.isArray(kept)) throw new Error("not an object");
    } catch (error) {
      console.error(`foxmate bench-mcp: --workflows ${workflows} is not a JSON object of kept workflows (${error instanceof Error ? error.message : error}).`);
      process.exit(2);
    }
  }
  const loadKept = async (session) => {
    if (kept) await session.sidebar.evaluate((value) => browser.storage.local.set({ workflows: value }), kept);
    return session;
  };
  const ready = () => (opened ??= start().then(loadKept).then((session) => ({ session, adapter: foxmateAdapter(session, { planner, approve, timeoutMs, ...(remote ? { renew: start } : {}) }) }), (error) => {
    opened = undefined;
    throw error;
  }));
  // No key, gate path or tunnel host in a reply (BM4).
  const scrub = async (text) => {
    const adapter = (await opened?.catch(() => undefined))?.adapter;
    const key = process.env.ICHABOD_API_KEY;
    return (adapter ? adapter.redact(text) : String(text)).replaceAll(key || "\0", "<key>").replace(TUNNEL_HOST, "<tunnel>");
  };
  const fail = async (text) => ({ isError: true, content: [{ type: "text", text: await scrub(text) }] });

  // One call at a time, in order (BM5).
  let queue = Promise.resolve();
  const runTask = (url, goal) => {
    const run = queue.then(async () => {
      const { session, adapter } = await ready();
      const result = await adapter.runTask({ url, goal });
      if (workflows) writeFileSync(workflows, JSON.stringify((await session.sidebar.evaluate(() => browser.storage.local.get("workflows"))).workflows ?? {}));
      return result;
    });
    queue = run.catch(() => undefined);
    return run;
  };

  const server = new Server({ name: "foxmate", version: "1" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: [TOOL] }));
  server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
    if (params.name !== TOOL.name) return fail(`No tool "${params.name}". The tool is run_task.`);
    const { url, goal } = params.arguments ?? {};
    if (typeof goal !== "string" || !goal.trim() || typeof url !== "string" || !/^https?:\/\//i.test(url)) return fail("run_task needs a goal and an http(s) url.");
    try {
      return { content: [{ type: "text", text: await scrub(JSON.stringify(await runTask(url, goal))) }] };
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error));
    }
  });

  // A stop from foxbench closes Firefox, the Ichabod session and the gates (BM7).
  let stopping;
  // A lost session can leave a close waiting forever, so the exit comes after 10 s at most.
  const stop = () => (stopping ??= (async () => {
    setTimeout(() => process.exit(0), 10_000).unref();
    const open = await opened?.catch(() => undefined);
    // Firefox first: foxbench kills the process tree 2 s after its SIGTERM (BM10).
    const closing = Date.now();
    if (open) {
      await open.session.fox.close().catch(() => undefined);
      console.error(`foxmate bench-mcp: closed Firefox in ${Date.now() - closing} ms.`);
    }
    await open?.adapter.close().catch(() => undefined);
    process.exit(0);
  })());
  for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, stop);
  process.stdin.on("close", stop);
  await server.connect(new StdioServerTransport());
}
