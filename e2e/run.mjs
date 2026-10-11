// The E2E test: foxmate in a real Firefox. It installs dist-ext/, runs
// goals through the real app page, background page, foxloop, foxgate,
// foxshield and foxtrail on the foxbench sites, and writes
// artifacts/e2e-<date>.json. The planner is the scripted one, so each run
// is the same. Usage: pnpm e2e [--headed]. Env: FIREFOX, and E2E_ONLY (a
// comma list of check names) to run some checks only.
import { randomUUID } from "node:crypto";
import { writeArtifact } from "create-foxkit/e2e";
import { sites, startServer } from "foxbench";
import activity from "./checks/activity.mjs";
import app from "./checks/app.mjs";
import bridge from "./checks/bridge.mjs";
import keepalive from "./checks/keepalive.mjs";
import lend from "./checks/lend.mjs";
import local from "./checks/local.mjs";
import memory from "./checks/memory.mjs";
import modules from "./checks/modules.mjs";
import notify from "./checks/notify.mjs";
import open, { OPEN_HOSTS } from "./checks/open.mjs";
import pass from "./checks/pass.mjs";
import pay from "./checks/pay.mjs";
import rules, { RULE_HOSTS } from "./checks/rules.mjs";
import phone, { PHONE_PREFS } from "./checks/phone.mjs";
import signup from "./checks/signup.mjs";
import space from "./checks/space.mjs";
import tasks from "./checks/tasks.mjs";
import traps from "./checks/traps.mjs";
import vault from "./checks/vault.mjs";
import voice from "./checks/voice.mjs";
import { BANK_HOSTS } from "./bank.mjs";
import { runGoal, startFox } from "./lib.mjs";

// app goes first: it checks the tabs before other checks open some. notify
// comes next: foxnotify allows 4 notices a minute, and the later checks send
// some too. rules and modules go after activity: Activity shows the newest 300
// entries, and their runs would push the older kinds out.
const CHECKS = { app, notify, signup, pass, vault, local, traps, memory, lend, space, phone, activity, modules, rules, open, pay, bridge, voice, tasks, keepalive };

const record = { startedAt: new Date().toISOString(), checks: [], runs: {} };
const check = (name, expected, actual) => record.checks.push({ name, expected, actual, ok: JSON.stringify(actual) === JSON.stringify(expected) });
const scripted = (steps) => ({ planner: "scripted", script: JSON.stringify(steps) });
const finish = { tool: "finish", args: { summary: "The task is done." } };

const bench = await startServer({ sites, controlKey: randomUUID() });
let session;
try {
  const headless = !process.argv.includes("--headed");
  session = { ...(await startFox({ headless, prefs: { "network.dns.localDomains": `${BANK_HOSTS},${RULE_HOSTS},${OPEN_HOSTS}`, "alerts.useSystemBackend": false, "media.navigator.streams.fake": true, "media.navigator.permission.disabled": true, ...PHONE_PREFS } })), headless };
  record.firefox = await session.fox.browser.version();

  const only = process.env.E2E_ONLY?.split(",").map((n) => n.trim());
  for (const [name, run] of Object.entries(CHECKS)) {
    if (only && !only.includes(name)) continue;
    try {
      await run({ session, bench, check, record, scripted, finish, runGoal });
    } catch (error) {
      check(`${name} ran to the end`, "no error", error instanceof Error ? error.stack : String(error));
    }
  }
} catch (error) {
  record.error = error instanceof Error ? error.stack : String(error);
} finally {
  await session?.fox.close();
  await bench.close();
}
record.passed = !record.error && record.checks.length > 0 && record.checks.every((c) => c.ok);
const path = writeArtifact("artifacts", "e2e", record);
for (const c of record.checks) console.log(`${c.ok ? "ok " : "BAD"} ${c.name}: ${JSON.stringify(c.actual)}`);
console.log(`${record.passed ? "PASS" : "FAIL"}${record.error ? `: ${record.error}` : ""} | ${path}`);
process.exitCode = record.passed ? 0 : 1;
