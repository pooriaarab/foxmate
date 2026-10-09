// K1-K2: the background page lifecycle. An approval can wait longer than
// Firefox's idle time (about 60 s) while the sidebar is open. When the page
// unloads anyway, the sidebar connects again and the task comes back.
import { serve, poll } from "create-foxkit/e2e";

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const ask = () => Boolean(document.querySelector("#conversation > li:last-child li.ask .row button"));
const approve = () => document.querySelector('#conversation > li:last-child li.ask button[data-answer="approve"]').click();
const ended = () => document.querySelector("#conversation > li:last-child .end")?.textContent ?? null;

export default async function keepaliveCheck({ session, check, scripted, finish }) {
  const { sidebar } = session;
  const site = await serve("e2e/site");
  try {
    const page = await session.fox.open(`${site.url}/table.html`);
    const start = async (goal) => {
      await sidebar.evaluate((s) => browser.storage.local.set({ settings: s }), scripted([{ tool: "snapshot", args: {} }, { tool: "browser_task", args: { goal: "name: Sam Lee, party size: 5" } }, finish]));
      await sidebar.evaluate(async (u, g) => window.foxmate.start(await window.foxmate.tabFor(u), g), page.url(), goal);
      await poll(sidebar, ask, undefined, 60_000);
    };
    const task = async (goal) => (await sidebar.evaluate(() => browser.runtime.sendMessage({ op: "tasks" }))).tasks.find((t) => t.input.goal === goal);

    // K1: wait 90 s before the approval, with the sidebar open.
    await sidebar.evaluate(() => { window.foxmateDropped = false; window.foxmate.port.onDisconnect.addListener(() => { window.foxmateDropped = true; }); });
    await start("Book a table for 5, slowly.");
    await sleep(90_000);
    await sidebar.evaluate(approve);
    const k1 = await poll(sidebar, ended, undefined, 60_000);
    const t1 = await task("Book a table for 5, slowly.");
    check("K1 an approval that waits 90 s still runs, in the same attempt", { dropped: false, done: true, attempt: 1 },
      { dropped: await sidebar.evaluate(() => window.foxmateDropped), done: k1.startsWith("Done"), attempt: t1?.steps[0]?.attempt });

    // K2: stop the pings, so Firefox unloads the page while the approval waits.
    await page.goto(`${site.url}/table.html`);
    await sidebar.evaluate(() => window.foxmate.keepAlive(false));
    await start("Book a table for 5, after a restart.");
    await poll(sidebar, () => window.foxmateDropped === true, undefined, 150_000);
    await sidebar.evaluate(() => window.foxmate.keepAlive(true));
    // The sidebar connects again, which wakes the page; foxrunner runs the cut-short step again.
    await poll(sidebar, ask, undefined, 120_000);
    await sidebar.evaluate(approve);
    const k2 = await poll(sidebar, ended, undefined, 60_000);
    const t2 = await task("Book a table for 5, after a restart.");
    check("K2 after the page unloads, the same sidebar connects again and the task finishes", { done: true, again: true },
      { done: k2.startsWith("Done"), again: (t2?.steps[0]?.attempt ?? 0) >= 2 });

    // K3 (Q2): two goals at once. The first keeps the sidebar and Stop; the second ends as refused (busy).
    await page.goto(`${site.url}/table.html`);
    await sidebar.evaluate((s) => browser.storage.local.set({ settings: s }), scripted([{ tool: "snapshot", args: {} }, { tool: "browser_task", args: { goal: "name: Sam Lee, party size: 6" } }, finish]));
    const runsBefore = await sidebar.evaluate(() => document.querySelectorAll("#conversation > li").length);
    await sidebar.evaluate(async (u) => {
      const tabId = await window.foxmate.tabFor(u);
      window.foxmate.start(tabId, "First of two goals.");
      window.foxmate.start(tabId, "Second of two goals.");
    }, page.url());
    await poll(sidebar, ask, undefined, 60_000);
    await sleep(3000);
    const shown = await sidebar.evaluate((n) => [...document.querySelectorAll("#conversation > li")].slice(n).map((li) => li.querySelector(".goal").textContent), runsBefore);
    await sidebar.evaluate(approve);
    const first = await poll(sidebar, ended, undefined, 60_000);
    const second = await task("Second of two goals.");
    check("K3 two goals at once: the first runs, the second ends as refused (busy)", { first: ["First of two goals."], done: true, second: "busy" },
      { first: shown, done: first.startsWith("Done"), second: second?.steps[0]?.output?.reason });
  } finally {
    await site.close();
  }
}
