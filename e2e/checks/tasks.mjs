// D1-D3: durable tasks. Each goal is a foxrunner task. A run that the
// background page loses (here: the extension reloads while an approval
// waits) runs again from its goal. A schedule starts a task on its own.
import { serve, poll } from "create-foxkit/e2e";
import { saveShot } from "../lib.mjs";

const tasks = (sidebar) => sidebar.evaluate(() => browser.runtime.sendMessage({ op: "tasks" }));

export default async function tasksCheck({ session, check, record, scripted, finish }) {
  const listed = await tasks(session.sidebar);
  check("D1 every earlier goal is a foxrunner task in Today", true, listed.tasks.length >= 5 && listed.tasks.some((t) => t.status === "done" && t.steps[0]?.output?.status === "done"));

  const site = await serve("e2e/site");
  try {
    // D2: start a run that stops at an approval, then reload the extension under it.
    const page = await session.fox.open(`${site.url}/table.html`);
    await session.sidebar.evaluate((s) => browser.storage.local.set({ settings: s }), scripted([{ tool: "snapshot", args: {} }, { tool: "browser_task", args: { goal: "name: Sam Lee, party size: 3" } }, finish]));
    await session.sidebar.evaluate(async (u) => window.foxmate.start(await window.foxmate.tabFor(u), "Book a table for 3."), page.url());
    await poll(session.sidebar, () => Boolean(document.querySelector("#conversation > li:last-child li.ask .row button")), undefined, 60_000);
    await session.sidebar.evaluate(() => browser.runtime.reload()).catch(() => undefined);
    await new Promise((r) => setTimeout(r, 1500));
    session.sidebar = await session.fox.openExtensionPage("sidebar.html");
    await poll(session.sidebar, () => Boolean(window.foxmate));
    await page.bringToFront();
    // foxrunner finds the cut-short step at the next wake and runs it again: the approval comes back.
    await poll(session.sidebar, () => Boolean(document.querySelector("#conversation > li:last-child li.ask .row button")), undefined, 90_000);
    await session.sidebar.evaluate(() => document.querySelector('#conversation > li:last-child li.ask button[data-answer="approve"]').click());
    await poll(session.sidebar, () => Boolean(document.querySelector("#conversation > li:last-child .end")), undefined, 60_000);
    const after = await tasks(session.sidebar);
    const task = after.tasks.find((t) => t.input.goal === "Book a table for 3.");
    record.runs.durable = task;
    check("D2 a run cut short by a reload runs again and finishes", { status: "done", end: "done", again: true, party: "3" },
      { status: task?.status, end: task?.steps[0]?.output?.status, again: (task?.steps[0]?.attempt ?? 0) >= 2, party: new URL(page.url()).searchParams.get("party") });

    // D3: a schedule through the Today view. "Every minute" fires within about a minute.
    await session.sidebar.evaluate((s) => browser.storage.local.set({ settings: s }), scripted([{ tool: "snapshot", args: {} }, finish]));
    const added = await session.sidebar.evaluate(async (url) => {
      window.foxmate.show("today");
      document.getElementById("schedule-goal").value = "Read the profile page.";
      document.getElementById("schedule-url").value = url;
      document.getElementById("schedule-when").value = "* * * * *";
      document.getElementById("schedule-form").requestSubmit();
      for (let i = 0; i < 50 && !document.getElementById("schedule-status").textContent; i++) await new Promise((r) => setTimeout(r, 100));
      return document.getElementById("schedule-status").textContent;
    }, `${site.url}/inject.html`);
    const fired = await poll(session.sidebar, async () => {
      const { tasks: list } = await browser.runtime.sendMessage({ op: "tasks" });
      return list.find((t) => t.scheduleId && t.status === "done") ?? null;
    }, undefined, 100_000);
    await session.sidebar.evaluate(() => window.foxmate.show("today"));
    await new Promise((r) => setTimeout(r, 500));
    await saveShot(session.sidebar, "today");
    check("D3 a schedule from the Today view starts a task that finishes", { added: "Added.", end: "done", why: undefined }, { added, end: fired.steps[0]?.output?.status, why: fired.steps[0]?.output?.message });
    const { schedules } = await tasks(session.sidebar);
    for (const s of schedules) await session.sidebar.evaluate((id) => browser.runtime.sendMessage({ op: "unschedule", id }), s.id);
    await session.sidebar.evaluate(() => window.foxmate.show("chat"));
  } finally {
    await site.close();
  }
}
