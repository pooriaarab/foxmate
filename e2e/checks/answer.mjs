// G53: a goal that only asks about the page finishes after foxloop's first
// read, with no planner tool call. The planner stand-in answers at once, as
// Saluki did on a Wikipedia tab. The helper says a sure "not done" to every
// check, as a small model does when the page shows no summary: an answer goal
// must still finish. An action goal that only read the page must not (G15),
// and nor may a goal of a question and an action.
import { serve } from "create-foxkit/e2e";
import { startHelper, startPlanner } from "../planner.mjs";

const finish = (summary) => ({ tool: "finish", args: { summary } });
/** The run's end, its planner calls, and whether the first request carried the article text. */
const ended = (run, planner) => ({ done: run.done, calls: planner.bodies.length, text: planner.bodies[0]?.includes("Phobos and Deimos") ?? false });

export default async function answerCheck({ session, check, record, runGoal }) {
  const { sidebar } = session;
  const [site, planner, helper] = await Promise.all([serve("e2e/site"), startPlanner(), startHelper({ done: false, sure: true, why: "the page shows no summary" })]);
  const before = await sidebar.evaluate(async () => (await browser.storage.local.get("settings")).settings ?? {});
  const settings = { planner: "llama-server", baseURL: planner.url, model: "fake", helper: { baseURL: helper.url }, replay: false };
  const url = `${site.url}/article.html`;
  record.runs.answer = {};
  try {
    for (const [name, goal, answer] of [
      ["a summary", "Summarize this page in 3 bullet points.", "- Mars is the fourth planet.\n- It has two moons, Phobos and Deimos.\n- A day lasts 24 h 37 min."],
      ["a question", "How many moons does Mars have?", "Mars has two moons: Phobos and Deimos."],
    ]) {
      planner.play([finish(answer)]);
      const run = await runGoal(session, { url, goal, settings, shot: name === "a summary" ? "chat-answer" : undefined });
      record.runs.answer[name] = { status: run.status, ...ended(run, planner) };
      check(`G53 ${name} goal finishes after the first read, in one planner call that has the page text`, { done: true, calls: 1, text: true, answer: true },
        { ...ended(run, planner), answer: run.status.includes("Phobos") });
    }
    // G15: the same page and the same instant finish, but the goal asks for an action.
    for (const [name, goal] of [["an action", "Subscribe to the newsletter with sam@example.com."], ["a question and an action", "Summarize this page and subscribe to the newsletter with sam@example.com."]]) {
      planner.play([finish("Done."), finish("Done.")]);
      const run = await runGoal(session, { url, goal, settings });
      record.runs.answer[name] = { status: run.status, ...ended(run, planner) };
      check(`G15 ${name} goal that only read the page does not pass`, { done: false, blocked: true },
        { done: run.done, blocked: /check-failed/.test(run.status) && run.status.includes("a tool ran with a good result") });
    }
  } finally {
    await sidebar.evaluate((s) => browser.storage.local.set({ settings: s }), before).catch(() => undefined);
    await Promise.all([site.close(), planner.close(), helper.close()]);
  }
}
