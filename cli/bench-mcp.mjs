// `foxmate bench-mcp`: an MCP server on stdio for `foxbench run --agent mcp`
// (docs/failure-modes.md BM1-BM8). Its one tool, run_task {url, goal}, runs
// one task with the foxmate bench adapter in one Firefox: local, or on
// Ichabod with FOXKIT_BROWSER=ichabod. foxbench scores the task; the reply
// is foxmate's own claim, log, answer and metrics.
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

export async function serveBenchMcp({ planner, approve, timeoutMs, headless = true, firefox }) {
  // stdout carries MCP messages only (BM1).
  console.log = console.info = console.debug = console.error;
  const remote = isRemote();
  const start = () => startFox({ headless, ...(remote ? { extension: benchExtension() } : {}), ...(firefox ? { firefox } : {}) });
  let opened;
  // A failed start is forgotten, so the next call tries again (BM3).
  const ready = () => (opened ??= start().then((session) => ({ session, adapter: foxmateAdapter(session, { planner, approve, timeoutMs, ...(remote ? { renew: start } : {}) }) }), (error) => {
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
    const run = queue.then(async () => (await ready()).adapter.runTask({ url, goal }));
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
  const stop = () => (stopping ??= (async () => {
    const open = await opened?.catch(() => undefined);
    await open?.adapter.close().catch(() => undefined);
    await open?.session.fox.close().catch(() => undefined);
    process.exit(0);
  })());
  for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, stop);
  process.stdin.on("close", stop);
  await server.connect(new StdioServerTransport());
}
