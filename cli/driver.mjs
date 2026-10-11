// Drive foxmate in a real Firefox: start Firefox with the built extension,
// and run a goal through the real app page. `foxmate try`, `foxmate bench`
// and the E2E test use it.
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { launch, poll } from "create-foxkit/e2e";

/** The built extension that ships in the npm package. */
export const EXTENSION = join(dirname(dirname(fileURLToPath(import.meta.url))), "dist-ext");

/**
 * Starts Firefox with dist-ext/ and opens the app page in a tab. The first
 * run shows the onboarding; `onboarding: false` (the default) marks it done.
 */
export async function startFox({ extension = EXTENSION, headless = true, prefs, firefox, onboarding = false } = {}) {
  const fox = await launch({ extension, headless, ...(prefs ? { prefs } : {}), ...(firefox ? { firefox } : {}) });
  const sidebar = await fox.openExtensionPage("app.html");
  await poll(sidebar, () => Boolean(window.foxmate));
  if (!onboarding) await sidebar.evaluate(() => browser.storage.local.set({ onboarding: { done: true } }));
  return { fox, sidebar };
}

export const setSettings = (sidebar, settings) => sidebar.evaluate((s) => browser.storage.local.set({ settings: s }), settings);
export const readTrail = (sidebar) => sidebar.evaluate(() => browser.runtime.sendMessage({ op: "trail" }));

/**
 * Opens `url` in a new tab and runs `goal` on it from the sidebar.
 * `answer(approval)` returns "approve" or "deny" for each approval.
 * Resolves with what the sidebar showed and what the trail recorded.
 */
export async function runGoal({ fox, sidebar }, { url, goal, settings, answer = () => "approve", page, timeoutMs = 120_000, onEnd, loanId }) {
  // A run on a loan works in the loan's own tab, which the background page knows.
  const tab = loanId ? page : (page ?? (await fox.open(url)));
  if (settings) await setSettings(sidebar, settings);
  const before = (await readTrail(sidebar)).entries.length;
  const runsBefore = await sidebar.evaluate(() => document.querySelectorAll("#conversation > li").length);
  if (loanId) await sidebar.evaluate((g, id) => window.foxmate.start(0, g, id), goal, loanId);
  else await sidebar.evaluate(async (u, g) => window.foxmate.start(await window.foxmate.tabFor(u), g), tab.url(), goal);
  // The sidebar is a tab here, not a sidebar. Keep the task tab in front, as a
  // person who watches the agent would: Firefox does not lay out a background
  // tab after a scroll, so foxpaw would see its controls as covered.
  await tab?.bringToFront();
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
      await onEnd?.(sidebar);
      const trail = await readTrail(sidebar);
      const steps = await sidebar.evaluate((n) => [...document.querySelectorAll("#conversation > li")[n].querySelectorAll(".steps li")].map((li) => li.textContent), runsBefore);
      const entries = trail.entries.slice(before).map((e) => ({ kind: e.kind, data: e.data }));
      return { status: state.end, done: state.className.includes("done"), approvals, steps, trail: entries, kinds: entries.map((e) => e.kind), trailOk: trail.verify.ok, page: tab, url: tab?.url() };
    }
    const choice = await answer(state.ask);
    approvals.push({ ...state.ask, answer: choice });
    if (choice === "wait") {
      // Another channel (the phone) answers. Wait until the sidebar shows it as answered.
      await poll(sidebar, (id) => !document.querySelector(`li.ask[data-request-id="${id}"] .row`), state.ask.requestId, timeoutMs);
      continue;
    }
    await sidebar.evaluate((id, a) => document.querySelector(`li.ask[data-request-id="${id}"] button[data-answer="${a}"]`).click(), state.ask.requestId, choice);
  }
}
