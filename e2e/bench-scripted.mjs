// The E2E test of the scripted planner on foxbench's core suite
// (docs/failure-modes.md BN10, B21). It runs `foxmate bench --planner
// scripted --suite core` in local headless Firefox, as a user does, and wants
// all 13 tasks to pass. Usage: pnpm e2e:scripted. Env: FIREFOX.
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeArtifact } from "create-foxkit/e2e";

const record = { startedAt: new Date().toISOString(), checks: [] };
const check = (name, expected, actual) => record.checks.push({ name, expected, actual, ok: JSON.stringify(actual) === JSON.stringify(expected) });
const args = ["cli/foxmate.mjs", "bench", "--planner", "scripted", "--suite", "core", "--out", mkdtempSync(join(tmpdir(), "bench-scripted-")), ...(process.env.FIREFOX ? ["--firefox", process.env.FIREFOX] : [])];
const run = spawnSync(process.execPath, args, { env: { ...process.env, MOZ_HEADLESS: "1" }, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"], timeout: 30 * 60_000 });
const rows = [...run.stdout.matchAll(/^(pass|fail) (\S+)/gm)].map((m) => ({ ok: m[1] === "pass", id: m[2] }));
record.rows = rows;
check("the core suite ran 13 tasks", 13, rows.length);
check("BN10 B21 tasks that failed", [], rows.filter((r) => !r.ok).map((r) => r.id));

record.passed = record.checks.every((c) => c.ok);
const path = writeArtifact("artifacts", "e2e-bench-scripted", record);
console.log(`${rows.filter((r) => r.ok).length} of ${rows.length} passed`);
for (const c of record.checks) console.log(`${c.ok ? "ok " : "BAD"} ${c.name}: ${JSON.stringify(c.actual)}`);
console.log(`${record.passed ? "PASS" : "FAIL"} | ${path}`);
process.exitCode = record.passed ? 0 : 1;
