// The E2E test: foxmate in a real Firefox. It installs dist-ext/, runs
// goals through the real sidebar, background page, foxloop, foxgate,
// foxshield and foxtrail on the foxbench sites, and writes
// artifacts/e2e-<date>.json. The planner is the scripted one, so each run
// is the same. Usage: pnpm e2e [--headed]. Env: FIREFOX.
import { randomUUID } from "node:crypto";
import { writeArtifact } from "create-foxkit/e2e";
import { sites, startServer } from "foxbench";
import privacy from "./checks/privacy.mjs";
import signup from "./checks/signup.mjs";
import traps from "./checks/traps.mjs";
import { runGoal, startFox } from "./lib.mjs";

const CHECKS = { signup, privacy, traps };

const record = { startedAt: new Date().toISOString(), checks: [], runs: {} };
const check = (name, expected, actual) => record.checks.push({ name, expected, actual, ok: JSON.stringify(actual) === JSON.stringify(expected) });
const scripted = (steps) => ({ planner: "scripted", script: JSON.stringify(steps) });
const finish = { tool: "finish", args: { summary: "The task is done." } };

const bench = await startServer({ sites, controlKey: randomUUID() });
let session;
try {
  session = await startFox({ headless: !process.argv.includes("--headed") });
  record.firefox = await session.fox.browser.version();

  for (const [name, run] of Object.entries(CHECKS)) {
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
