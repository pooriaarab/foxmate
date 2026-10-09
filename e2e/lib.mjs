// Helpers for the E2E tests and `foxmate bench`: start Firefox with the
// built extension, and run a goal through the real sidebar.
import { readFileSync, writeFileSync } from "node:fs";
import { launch, poll } from "create-foxkit/e2e";

/**
 * With FOXMATE_SHOTS=<dir>, saves the rendered sidebar as <dir>/<name>.html
 * with its CSS. BiDi cannot capture moz-extension: pages, so the screenshots
 * come from these files, served over http.
 */
export async function saveShot(sidebar, name) {
  const dir = process.env.FOXMATE_SHOTS;
  if (!dir || !name) return;
  const body = await sidebar.evaluate(() => {
    for (const area of document.querySelectorAll("textarea")) area.textContent = area.value;
    for (const input of document.querySelectorAll("input")) input.setAttribute("value", input.value);
    for (const box of document.querySelectorAll("input[type=checkbox], input[type=radio]")) box.toggleAttribute("checked", box.checked);
    for (const select of document.querySelectorAll("select")) for (const o of select.options) o.toggleAttribute("selected", o.selected);
    return document.body.innerHTML;
  });
  writeFileSync(`${dir}/${name}.html`, `<!doctype html><meta charset="utf-8"><style>${readFileSync("extension/sidebar.css", "utf8")}</style><body>${body}</body>`);
}

/** Starts Firefox with dist-ext/ and opens the sidebar page in a tab. */
export async function startFox({ extension = "dist-ext", headless = true, prefs } = {}) {
  const fox = await launch({ extension, headless, ...(prefs ? { prefs } : {}) });
  const sidebar = await fox.openExtensionPage("sidebar.html");
  await poll(sidebar, () => Boolean(window.foxmate));
  return { fox, sidebar };
}

export const setSettings = (sidebar, settings) => sidebar.evaluate((s) => browser.storage.local.set({ settings: s }), settings);
export const readTrail = (sidebar) => sidebar.evaluate(() => browser.runtime.sendMessage({ op: "trail" }));

/**
 * Opens `url` in a new tab and runs `goal` on it from the sidebar.
 * `answer(approval)` returns "approve" or "deny" for each approval.
 * Resolves with what the sidebar showed and what the trail recorded.
 */
export async function runGoal({ fox, sidebar }, { url, goal, settings, answer = () => "approve", page, timeoutMs = 120_000, shot }) {
  const tab = page ?? (await fox.open(url));
  if (settings) await setSettings(sidebar, settings);
  const before = (await readTrail(sidebar)).entries.length;
  const runsBefore = await sidebar.evaluate(() => document.querySelectorAll("#conversation > li").length);
  await sidebar.evaluate(async (u, g) => window.foxmate.start(await window.foxmate.tabFor(u), g), tab.url(), goal);
  // The sidebar is a tab here, not a sidebar. Keep the task tab in front, as a
  // person who watches the agent would: Firefox does not lay out a background
  // tab after a scroll, so foxpaw would see its controls as covered.
  await tab.bringToFront();
  const approvals = [];
  for (;;) {
    const state = await poll(sidebar, (n) => {
      const run = document.querySelectorAll("#conversation > li")[n];
      if (!run) return null;
      const ask = run.querySelector("li.ask .row button")?.closest("li");
      if (ask) return { ask: { requestId: ask.dataset.requestId, text: ask.querySelector("pre").textContent, detail: ask.querySelector(".detail")?.textContent ?? "" } };
      const end = run.querySelector(".end");
      return end ? { end: end.textContent, className: end.className } : null;
    }, runsBefore, timeoutMs);
    if (state.end) {
      await saveShot(sidebar, shot);
      const trail = await readTrail(sidebar);
      const steps = await sidebar.evaluate((n) => [...document.querySelectorAll("#conversation > li")[n].querySelectorAll(".steps li")].map((li) => li.textContent), runsBefore);
      const entries = trail.entries.slice(before).map((e) => ({ kind: e.kind, data: e.data }));
      return { status: state.end, done: state.className.includes("done"), approvals, steps, trail: entries, kinds: entries.map((e) => e.kind), trailOk: trail.verify.ok, page: tab, url: tab.url() };
    }
    const choice = await answer(state.ask);
    approvals.push({ ...state.ask, answer: choice });
    await sidebar.evaluate((id, a) => document.querySelector(`li.ask[data-request-id="${id}"] button[data-answer="${a}"]`).click(), state.ask.requestId, choice);
  }
}
