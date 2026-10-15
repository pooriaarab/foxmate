// Times readFrame's inner helpers on real pages: each helper's outermost calls only.
//   node spike/handwired/profile-read.mjs <url>...
import { launch } from "create-foxkit/e2e";
import { readFrame } from "../../node_modules/foxpaw/dist/page/snapshot.js";
import { EXTENSION } from "../../cli/driver.mjs";

const HELPERS = ["visible", "name", "section", "rowHash", "pointer", "icon", "clickable", "near", "fields", "disclosure", "formatOf", "deep", "state", "role", "shown", "context", "inRow"];
let src = readFrame.toString().replace(/^function readFrame\(\) \{/, "function readFrame() { const __s = {}, __d = {}; const __t = (k, f) => { if (__d[k]) return f(); __d[k] = 1; const t = performance.now(); try { return f(); } finally { __d[k] = 0; __s[k] = (__s[k] || 0) + performance.now() - t; } };");
for (const h of HELPERS) {
  const re = new RegExp(`const ${h} = \\(`);
  if (!re.test(src)) throw new Error(`no helper ${h}`);
  src = src.replace(re, `const ${h} = (...a) => __t("${h}", () => __${h}(...a)); const __${h} = (`);
}
src = src.replace(/cache\.guard = \(e\) =>/, "cache.guard = (e) => __t('guard', () => __guard(e)); const __guard = (e) =>");
src = src.replace(/const words = \[\];/, "__s.beforeText = performance.now() - __start; const words = [];");
src = src.replace("const __s = {}, __d = {};", "const __s = {}, __d = {}; const __start = performance.now();");
src = src.replace(/return \{\s*url: location\.href,/, "__s.total = performance.now() - __start; return { __s, url: location.href,");
const fox = await launch({ extension: EXTENSION, headless: true, prefs: { "privacy.reduceTimerPrecision": false } });
try {
  for (const url of process.argv.slice(2)) {
    const page = await fox.browser.newPage();
    await page.goto(url, { timeout: 30_000, waitUntil: "load" }).catch(() => undefined);
    await new Promise((r) => setTimeout(r, 2000));
    const s = await page.evaluate(`(() => { const read = ${src}; read(); return read().__s; })()`);
    console.log(url, Object.entries(s).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v.toFixed(0)}`).join(" "));
    await page.close();
  }
} finally { await fox.close(); }
