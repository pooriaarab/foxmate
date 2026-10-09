#!/usr/bin/env node
// The foxmate command.
//   foxmate try     open a fresh Firefox profile with foxmate installed
//   foxmate bench   score foxmate on foxbench in a real Firefox
import { parseArgs } from "node:util";
import { runSuite, taskById, toMarkdown, writeScore } from "foxbench";
import { foxmateAdapter } from "./bench.mjs";
import { startFox } from "./driver.mjs";

const HELP = `foxmate try [--firefox <path>]
  Opens Firefox with a fresh, temporary profile and foxmate installed.
  Click the foxmate button in the toolbar to open the sidebar. Close
  Firefox or press Ctrl-C to stop; the profile is deleted.

foxmate bench [options]
  Scores foxmate on the 13 foxbench tasks in a real Firefox.
  --planner <id>     scripted (default), ollama, llama-server or saluki
  --model <name>     the model for ollama or llama-server
  --base-url <url>   the server address, for example http://127.0.0.1:11434/v1
  --approve <rule>   careful (default), all or none: how the stand-in human answers
  --tasks <ids>      only these tasks, comma-separated
  --timeout <s>      the longest time for one task (default 600)
  --out <dir>        where to write the scoreboard (default artifacts)
  --headed           show the Firefox window
  --firefox <path>   the Firefox binary`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    planner: { type: "string", default: "scripted" }, model: { type: "string" }, "base-url": { type: "string" },
    approve: { type: "string", default: "careful" }, tasks: { type: "string" }, timeout: { type: "string", default: "600" },
    out: { type: "string", default: "artifacts" }, headed: { type: "boolean", default: false }, firefox: { type: "string" }, help: { type: "boolean" },
  },
});
const command = positionals[0];

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
} else if (command === "bench") {
  if (!["careful", "all", "none"].includes(values.approve)) {
    console.error("--approve must be careful, all or none.");
    process.exit(2);
  }
  const only = values.tasks?.split(",").map((id) => taskById(id.trim()));
  if (only?.includes(undefined)) {
    console.error(`--tasks names a task that foxbench does not have. Run "npx foxbench list".`);
    process.exit(2);
  }
  const planner = { privacy: "private", planner: values.planner, ...(values.model ? { model: values.model } : {}), ...(values["base-url"] ? { baseURL: values["base-url"] } : {}) };
  const session = await startFox({ headless: !values.headed, ...(values.firefox ? { firefox: values.firefox } : {}) });
  try {
    const adapter = foxmateAdapter(session, { planner, approve: values.approve, timeoutMs: Number(values.timeout) * 1000 });
    const board = await runSuite({
      adapter,
      timeoutMs: Number(values.timeout) * 1000 + 30_000,
      ...(only ? { tasks: only } : {}),
      onResult: (r) => console.log(`${r.success ? "pass" : "fail"} ${r.id}${r.attack ? ` (attack ${r.attack})` : ""}`),
    });
    console.log(toMarkdown(board));
    console.log(writeScore(board, values.out));
  } finally {
    await session.fox.close();
  }
} else {
  console.error(`Unknown command "${command}".\n\n${HELP}`);
  process.exit(2);
}
