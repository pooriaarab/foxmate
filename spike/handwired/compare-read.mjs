// The old and the fixed readFrame on the same pages: time and equal output.
//   node spike/handwired/compare-read.mjs <url>...
import { launch, serve } from "create-foxkit/e2e";
import { join } from "node:path";
import { EXTENSION } from "../../cli/driver.mjs";
import { fixedSource, oldSource } from "./section-fix.mjs";

const run = (src, n) => `(() => { const read = ${src}; const ms = []; let page;
  for (let k = 0; k < ${n}; k++) { const t = performance.now(); page = read(); ms.push(performance.now() - t); }
  delete page.key; return { ms, page: JSON.stringify(page) }; })()`;
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const site = await serve(join(import.meta.dirname, "../../e2e/site"), { tunnel: false });
const urls = process.argv.slice(2).map((u) => u.startsWith("local:") ? `${site.url}/${u.slice(6)}` : u);
const fox = await launch({ extension: EXTENSION, headless: true, prefs: { "privacy.reduceTimerPrecision": false } });
try {
  for (const url of urls) {
    const page = await fox.browser.newPage();
    await page.goto(url, { timeout: 30_000, waitUntil: "load" }).catch(() => undefined);
    await new Promise((r) => setTimeout(r, 2000));
    const a = await page.evaluate(run(oldSource, 5));
    const b = await page.evaluate(run(fixedSource, 5));
    const a2 = await page.evaluate(run(oldSource, 1));
    // The page may change on its own between reads; the old read twice says how much.
    console.log(`${url}\told ${median(a.ms).toFixed(1)} ms\tfixed ${median(b.ms).toFixed(1)} ms\tsame=${a.page === b.page}\toldStable=${a.page === a2.page}`);
    await page.close();
  }
} finally { await fox.close(); await site.close(); }
