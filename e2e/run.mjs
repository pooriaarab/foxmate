// The E2E test: foxmate in a real Firefox. It installs dist-ext/, runs
// goals through the real sidebar, background page, foxloop, foxgate,
// foxshield and foxtrail on the foxbench sites, and writes
// artifacts/e2e-<date>.json. The planner is the scripted one, so each run
// is the same. Usage: pnpm e2e [--headed]. Env: FIREFOX.
import { randomUUID } from "node:crypto";
import { writeArtifact } from "create-foxkit/e2e";
import { judge, sites, startServer, taskById } from "foxbench";
import { runGoal, startFox } from "./lib.mjs";

const record = { startedAt: new Date().toISOString(), checks: [], runs: {} };
const check = (name, expected, actual) => record.checks.push({ name, expected, actual, ok: JSON.stringify(actual) === JSON.stringify(expected) });
const scripted = (steps) => ({ planner: "scripted", script: JSON.stringify(steps) });
const finish = { tool: "finish", args: { summary: "The task is done." } };

const bench = await startServer({ sites, controlKey: randomUUID() });
let session;
try {
  session = await startFox({ headless: !process.argv.includes("--headed") });
  record.firefox = await session.fox.browser.version();

  // E1: a foxbench task through the sidebar, with one approval.
  const task = taskById("signup-pro");
  const signup = await runGoal(session, {
    url: bench.reset(task),
    goal: task.goal,
    shot: "chat-signup",
    settings: scripted([
      { tool: "snapshot", args: {} },
      ...[["Full name", "Ana Silva"], ["Work email", "ana.silva@example.com"], ["Password", "Tr4il-Mix-2026"], ["Confirm password", "Tr4il-Mix-2026"]]
        .map(([label, value]) => ({ tool: "act", args: { controlId: `{{control:${label}}}`, op: "type", value } })),
      { tool: "act", args: { controlId: "{{control:Pro ·}}", op: "check" } },
      // foxpaw does not scroll to a control whose top is on the screen but whose centre is not.
      { tool: "act", args: { controlId: "{{control:Full name}}", op: "scroll", value: "300" } },
      { tool: "act", args: { controlId: "{{control:newsletter}}", op: "uncheck" } },
      { tool: "act", args: { controlId: "{{control:Terms of Service}}", op: "check" } },
      { tool: "act", args: { controlId: "{{control:Country}}", op: "select", value: "ES" } },
      { tool: "click", args: { controlId: "{{control:Create account}}" } },
      finish,
    ]),
  });
  record.runs.signup = { status: signup.status, approvals: signup.approvals, steps: signup.steps, kinds: signup.kinds };
  const verdict = judge(task, bench.state);
  check("E1 signup-pro: foxbench's oracle passes", { success: true, attack: null }, { success: verdict.success, attack: verdict.attack });
  check("E1 signup-pro: one approval, for the Create account click", ["click"], signup.approvals.map((a) => JSON.parse(a.text).tool));
  check("E1 signup-pro: the sidebar shows Done", true, signup.done);
  check("E1 signup-pro: the trail has the run, the approval, the scan and the end", true,
    ["run.start", "shield.scan", "loop.approval-needed", "approval.answer", "loop.tool-result", "loop.done", "run.end"].every((k) => signup.kinds.includes(k)));
  check("E1 signup-pro: the trail verifies", true, signup.trailOk);
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
