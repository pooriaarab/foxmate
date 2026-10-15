// Reads real pages with foxpaw's readFrame in headless Firefox and saves the
// snapshots, readFrame's own time in the page, and whether WebGPU is there.
//   node spike/handwired/capture.mjs <out.json>
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { launch, serve } from "create-foxkit/e2e";
import { readFrame } from "../../node_modules/foxpaw/dist/page/snapshot.js";
import { EXTENSION } from "../../cli/driver.mjs";

const PUBLIC = [
  "https://en.wikipedia.org/wiki/Firefox",
  "https://news.ycombinator.com/",
  "https://github.com/mozilla-firefox/firefox",
  "https://developer.mozilla.org/en-US/docs/Web/API/WebGPU_API",
  "https://www.bbc.com/news",
  "https://stackoverflow.com/questions/11227809/why-is-processing-a-sorted-array-faster-than-processing-an-unsorted-array",
  "https://www.amazon.com/s?k=usb+c+cable",
  "https://www.ebay.com/sch/i.html?_nkw=usb+c+cable",
  "https://old.reddit.com/r/firefox/",
  "https://www.python.org/",
  "https://docs.python.org/3/library/functions.html",
  "https://www.craigslist.org/about/sites",
];
const LOCAL = ["article.html", "table.html", "settle-cart.html", "settle-review.html", "dialog.html", "notice-bank.html"];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const probe = `(async () => { try { const a = navigator.gpu && await navigator.gpu.requestAdapter(); return { gpu: !!navigator.gpu, adapter: !!a }; } catch (e) { return { gpu: !!navigator.gpu, error: String(e) }; } })()`;
const measure = `(() => { const read = ${readFrame.toString()}; const ms = []; let page;
  for (let k = 0; k < 7; k++) { const t = performance.now(); page = read(); ms.push(performance.now() - t); }
  return { ms, page, elements: document.getElementsByTagName("*").length }; })()`;

const out = process.argv[2];
const site = await serve(join(import.meta.dirname, "../../e2e/site"), { tunnel: false });
const fox = await launch({ extension: EXTENSION, headless: true });
const results = { firefox: (await fox.browser.version()), pages: [] };
try {
  const ext = await fox.openExtensionPage("app.html");
  results.webgpuExtension = await ext.evaluate(probe);
  for (const url of [...PUBLIC, ...LOCAL.map((p) => `${site.url}/${p}`)]) {
    let page;
    try {
      page = await fox.browser.newPage();
      await page.goto(url, { timeout: 30_000, waitUntil: "load" }).catch(() => undefined);
      await sleep(2000);
      const m = await page.evaluate(measure);
      const gpu = results.pages.length === 0 ? await page.evaluate(probe) : undefined;
      if (gpu) results.webgpuPage = gpu;
      results.pages.push({ url, elements: m.elements, controls: m.page?.controls.length ?? 0, readMs: m.ms, snapshot: m.page });
      console.log(url, "elements", m.elements, "controls", m.page?.controls.length, "readFrame ms", m.ms.map((x) => x.toFixed(1)).join(" "));
    } catch (error) {
      console.log(url, "failed", String(error).slice(0, 120));
    } finally {
      await page?.close().catch(() => undefined);
    }
  }
} finally {
  await fox.close();
  await site.close();
}
writeFileSync(out, JSON.stringify(results));
console.log("webgpu", JSON.stringify(results.webgpuExtension), JSON.stringify(results.webgpuPage));
