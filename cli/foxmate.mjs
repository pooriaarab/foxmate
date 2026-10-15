#!/usr/bin/env node
// The foxmate command.
//   foxmate try     open a fresh Firefox profile with foxmate installed
//   foxmate bench   score foxmate on foxbench in a real Firefox
//   foxmate bench-mcp   an MCP server for foxbench run --agent mcp
import { join } from "node:path";
import { parseArgs } from "node:util";
import { writeArtifact } from "create-foxkit/e2e";
import { SUITES, runSuite, taskById, tasksIn, toMarkdown, writeScore } from "foxbench";
import { foxmateAdapter } from "./bench.mjs";
import { serveBenchMcp } from "./bench-mcp.mjs";
import { startFox } from "./driver.mjs";
import { benchExtension, isRemote } from "./remote.mjs";

const HELP = `foxmate try [--firefox <path>]
  Opens Firefox with a fresh, temporary profile and foxmate installed.
  Click the foxmate button in the toolbar to open the sidebar. Close
  Firefox or press Ctrl-C to stop; the profile is deleted.

foxmate bench [options]
  Scores foxmate on foxbench in a real Firefox.
  --suite <name>     core (default, the 13 tasks of foxbench 0.1.x), hard, security+ or all
  --planner <id>     scripted (default), ollama, llama-server or saluki
  --model <name>     the model for ollama or llama-server
  --base-url <url>   the server address, for example http://127.0.0.1:11434/v1
  --approve <rule>   careful (default), all or none: how the stand-in human answers
  --ask <on|off>     on (default): the planner may ask the user, and Ask Sam answers
  --scout <url|off>  the fast helper model (default http://127.0.0.1:8082/v1), or off
  --replay <on|off>  on (default): a goal that ran done before replays its kept calls
  --repeat           run the tasks a second time in the same Firefox, and write
                     that pass to <out>/repeat as repeat-run scores
  --fixed-ports <n>  one port per site from port n (foxbench 0.1.6+), so a site keeps
                     its origin and --repeat can replay kept workflows (BN6)
  --tasks <ids>      only these tasks, from any suite, comma-separated
  --timeout <s>      the longest time for one task (default 600)
  --out <dir>        where to write the scoreboard (default artifacts)
  --headed           show the Firefox window
  --firefox <path>   the Firefox binary
  FOXKIT_BROWSER=ichabod with ICHABOD_API_KEY runs the bench in Firefox on
  Ichabod. Build dist-ext-bench/ first: node scripts/build-ext.mjs --bench-remote

foxmate bench-mcp [--planner, --model, --base-url, --approve, --ask, --scout,
                   --replay, --timeout, --headed, --firefox as for bench]
                  [--workflows <file>]
  An MCP server on stdio with one tool, run_task {url, goal}, for
  foxbench run --agent mcp -- foxmate bench-mcp. Each call runs one task
  in one Firefox, one call at a time. FOXKIT_BROWSER=ichabod as for bench.
  --workflows <file> keeps the kept workflows in a file: it is loaded at start
  and written after each task, so a second run replays (WF28). A file that
  is not a JSON object ends the command with code 2.`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    planner: { type: "string", default: "scripted" }, model: { type: "string" }, "base-url": { type: "string" },
    approve: { type: "string", default: "careful" }, ask: { type: "string", default: "on" }, scout: { type: "string" }, replay: { type: "string", default: "on" }, repeat: { type: "boolean", default: false }, "fixed-ports": { type: "string" }, workflows: { type: "string" }, suite: { type: "string", default: "core" }, tasks: { type: "string" }, timeout: { type: "string", default: "600" },
    out: { type: "string", default: "artifacts" }, headed: { type: "boolean", default: false }, firefox: { type: "string" }, help: { type: "boolean" },
  },
});
const command = positionals[0];

/** The planner settings of bench and bench-mcp. A bad flag exits with code 2, before Firefox starts. */
function benchPlanner() {
  if (!["careful", "all", "none"].includes(values.approve)) {
    console.error("--approve must be careful, all or none.");
    process.exit(2);
  }
  for (const flag of ["ask", "replay"]) {
    if (!["on", "off"].includes(values[flag])) {
      console.error(`--${flag} must be on or off.`);
      process.exit(2);
    }
  }
  const scout = values.scout === undefined ? {} : { helper: values.scout === "off" ? { off: true } : { baseURL: values.scout } };
  return { planner: values.planner, ...(values.model ? { model: values.model } : {}), ...(values["base-url"] ? { baseURL: values["base-url"] } : {}), ...(values.ask === "off" ? { ask: false } : {}), ...(values.replay === "off" ? { replay: false } : {}), ...scout };
}

if (values.help || !command) {
  console.log(HELP);
} else if (command === "try") {
  const session = await startFox({ headless: false, ...(values.firefox ? { firefox: values.firefox } : {}) });
  await session.sidebar.close();
  console.log("Firefox is open with foxmate. Close Firefox or press Ctrl-C to stop.");
  const stop = async () => {
    await session.fox.close();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  session.fox.browser.on("disconnected", stop);
} else if (command === "bench-mcp") {
  await serveBenchMcp({ planner: benchPlanner(), approve: values.approve, timeoutMs: Number(values.timeout) * 1000, headless: !values.headed, ...(values.workflows ? { workflows: values.workflows } : {}), ...(values.firefox ? { firefox: values.firefox } : {}) });
} else if (command === "bench") {
  const planner = benchPlanner();
  const suites = [...SUITES, "all"];
  if (!suites.includes(values.suite)) {
    console.error(`--suite must be one of: ${suites.join(", ")}.`);
    process.exit(2);
  }
  const only = values.tasks?.split(",").map((id) => taskById(id.trim()));
  if (only?.includes(undefined)) {
    console.error(`--tasks names a task that foxbench does not have. Run "npx foxbench list".`);
    process.exit(2);
  }
  const fixedPorts = values["fixed-ports"] === undefined ? undefined : Number(values["fixed-ports"]);
  if (fixedPorts !== undefined && !(Number.isInteger(fixedPorts) && fixedPorts >= 1024 && fixedPorts <= 65000)) {
    console.error("--fixed-ports must be a port from 1024 to 65000.");
    process.exit(2);
  }
  // FOXKIT_BROWSER=ichabod: Firefox on Ichabod, with the remote bench build.
  const remote = isRemote();
  const start = () => startFox({ headless: !values.headed, ...(remote ? { extension: benchExtension() } : {}), ...(values.firefox ? { firefox: values.firefox } : {}) });
  const session = await start();
  try {
    const adapter = foxmateAdapter(session, { planner, approve: values.approve, timeoutMs: Number(values.timeout) * 1000, ...(remote ? { renew: start } : {}) });
    // A second pass in the same Firefox finds the first pass's kept workflows (WF8).
    for (const [pass, out] of [["", values.out], ...(values.repeat ? [["repeat ", join(values.out, "repeat")]] : [])]) {
      const board = await runSuite({
        adapter,
        timeoutMs: Number(values.timeout) * 1000 + 30_000,
        ...(fixedPorts === undefined ? {} : { fixedPorts }),
        tasks: only ?? tasksIn(values.suite),
        onResult: (r) => console.log(`${pass}${r.success ? "pass" : "fail"} ${r.id}${r.attack ? ` (attack ${r.attack})` : ""}`),
      });
      console.log(toMarkdown(board));
      console.log(writeScore(board, out));
    }
  } finally {
    await session.fox.close();
    // The Ichabod session IDs, to find each recording on the Ichabod console.
    if (remote) console.log(writeArtifact(values.out, "ichabod-sessions", { suite: values.suite }));
  }
} else {
  console.error(`Unknown command "${command}".\n\n${HELP}`);
  process.exit(2);
}
