// Runs web-ext lint on dist-ext/ and fails on any error or warning, except
// the ones below. Each one is expected and has a reason. A new warning, or
// one of these for another key, still fails. browser-model.js and ort/ are
// skipped: transformers.js and ONNX Runtime evaluate strings.
import { spawnSync } from "node:child_process";

const allowed = [
  // strict_min_version is 153 (the ESR). The sandbox key is from Firefox 154.
  // On 153 foxden falls back to the iframe sandbox attribute.
  (w) => w.code.endsWith("UNSUPPORTED_BY_MIN_VERSION") && /support for "(sandbox|sandbox\.pages|content_security_policy\.sandbox)"\.$/.test(w.description),
  // The den page starts its worker from a bundled string (worker-src blob:),
  // because an opaque origin cannot load a worker by URL. connect-src 'none'.
  (w) => w.code === "MANIFEST_CSP" && w.message.startsWith('"content_security_policy.sandbox"'),
];

const lint = spawnSync("pnpm", ["exec", "web-ext", "lint", "-s", "dist-ext", "-o", "json", "--ignore-files", "browser-model.js", "ort/*"], { encoding: "utf8" });
const report = JSON.parse(lint.stdout.slice(lint.stdout.indexOf("{")));
const blocking = [...report.errors, ...report.warnings.filter((w) => !allowed.some((ok) => ok(w)))];
for (const w of report.warnings) if (!blocking.includes(w)) console.log(`allowed ${w.code}: ${w.description}`);
for (const p of blocking) console.error(`${p.code} ${p.file ?? ""}: ${p.message} ${p.description ?? ""}`);
console.log(`web-ext lint: ${report.errors.length} errors, ${report.warnings.length} warnings (${blocking.length} blocking), ${report.notices.length} notices`);
process.exitCode = blocking.length > 0 ? 1 : 0;
