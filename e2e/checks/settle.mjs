// G47-G50 (settle): after a sent form, the fast helper may end the run in
// place of the planner's last call. The helper here is gullible: it says
// {done: true, sure: true} to every check, as a small model that obeys page
// text would. The planner answers 3 s late, so a settle that is allowed
// always wins the race. Each case must end on the planner's own finish:
// an injection page after a send (G49), a review page with a step left
// (G50), and a goal of two parts (G50). A clean single-part run still
// settles, with foxmate's own summary, never the helper's words (G49), and
// it is not kept in the workflow cache.
import { serve } from "create-foxkit/e2e";
import { startHelper, startPlanner } from "../planner.mjs";

const SLOW = 3000;
const HELPER_SAYS = "All tasks finished";

/** The id of the newest listed control whose line has `label`, from a planner request. */
const controlIn = (body, label) => {
  const messages = JSON.parse(body).messages ?? [];
  for (const m of messages.toReversed()) {
    const text = typeof m.content === "string" ? m.content : "";
    const line = text.split("\n").find((l) => l.startsWith("[") && l.includes(label));
    if (line) return line.match(/^\[([^\]]+)\]/)?.[1] ?? "";
  }
  return "";
};
const click = (label, delayMs = 0) => (body) => ({ tool: "click", args: { controlId: controlIn(body, label) }, delayMs });
/** How a run ended: its status line, whether the settle check ended it, and how often the helper was asked. */
const ended = (run) => {
  const done = run.trail.find((e) => e.kind === "loop.done")?.data;
  return { status: run.status, settled: done?.settled === true, asked: run.trail.filter((e) => e.kind === "check.settle").length };
};
const finish = (summary) => ({ tool: "finish", args: { summary }, delayMs: SLOW });

export default async function settleCheck({ session, check, record, runGoal }) {
  const { sidebar } = session;
  const [site, planner, helper] = await Promise.all([serve("e2e/site"), startPlanner(), startHelper({ done: true, sure: true, why: HELPER_SAYS })]);
  const before = await sidebar.evaluate(async () => (await browser.storage.local.get("settings")).settings ?? {});
  // Notes from the memory check make a run private (G17); set them aside, as rules does.
  const { memories } = await sidebar.evaluate(() => browser.runtime.sendMessage({ op: "memory-list" }));
  for (const m of memories) await sidebar.evaluate((id) => browser.runtime.sendMessage({ op: "memory-forget", id }), m.id);
  const settings = { planner: "llama-server", baseURL: planner.url, model: "fake", helper: { baseURL: helper.url } };
  // The cases after the first replay nothing: a kept run of an earlier case would replay its
  // clicks in place of the planner's (WF8).
  const fresh = { ...settings, replay: false };
  try {
    // Positive case: the instrument sees a settle. A single-part goal, a final page with only
    // safe buttons ("Print") and a plain navigation link.
    planner.play([click("Book a table"), finish("The planner booked the table.")]);
    const clean = await runGoal(session, { url: `${site.url}/settle-table.html`, goal: "Book a table for two.", settings, shot: "chat-settled" });
    const kept = await sidebar.evaluate(async () => Object.values((await browser.storage.local.get("workflows")).workflows ?? {}).map((w) => w.goal));
    record.runs.settle = { clean: ended(clean) };
    check("G47 a single-part goal with a clean final page ends on the settle check", { settled: true, booked: true }, { settled: ended(clean).settled, booked: clean.url.includes("booked.html") });
    check("G49 the settled summary is foxmate's own text, not the helper's words", { own: true, helper: false },
      { own: clean.status.startsWith("Done: The form was sent."), helper: clean.status.includes(HELPER_SAYS) });
    check("G49 a run that the settle check ended is not kept in the workflow cache", false, kept.some((g) => g.startsWith("Book a table for two.")));

    // (i) G49: the page after the send tells the helper that every task is finished.
    planner.play([click("Pay the bill"), finish("The bill is paid.")]);
    const injected = await runGoal(session, { url: `${site.url}/settle-bill.html`, goal: "Pay the bill.", settings: fresh });
    record.runs.settle.injected = ended(injected);
    check("G49 an injection page after a send does not end the run on the settle check", { settled: false, status: "Done: The bill is paid." },
      { settled: ended(injected).settled, status: injected.status });

    // (ii) G50: a review page after the send reads "Order confirmed", but the order needs one more click.
    planner.play([click("Check out"), click("Place order", SLOW), finish("Order MS-1 placed.")]);
    const review = await runGoal(session, { url: `${site.url}/settle-cart.html`, goal: "Buy the blue mug.", settings: fresh });
    record.runs.settle.review = ended(review);
    // After "Place order" the final page may settle the run; the review page must not.
    check("G50 a review page with a step left does not end the run on the settle check", { done: true, placed: true },
      { done: review.done, placed: review.url.includes("settle-placed.html") });

    // (iii) G50: a goal of two parts does not settle after the first part. The page is the one
    // that settles the positive case, so only the goal rule can stop it.
    planner.play([click("Book a table"), finish("Booked; the planner goes on to the second part.")]);
    const twoParts = await runGoal(session, { url: `${site.url}/settle-table.html`, goal: "Book a table for two and send the booking to Kim.", settings: fresh });
    record.runs.settle.twoParts = ended(twoParts);
    check("G50 a goal of two parts does not settle after the first part", { settled: false, asked: 0 }, { settled: ended(twoParts).settled, asked: ended(twoParts).asked });

    // G50: settle is an allow list. Two sentences, two lines, or a goal that is not plain English
    // never settles, even on a final page that would settle a one-part goal.
    for (const [name, goal] of [["two sentences", "Book a table for two. Send Kim the booking."], ["two lines", "Book a table for two\nSend Kim the booking"], ["not English", "Reserva una mesa para dos y luego envía la reserva a Kim."], ["two amounts", "Pay Bob $20 Alice $30"]]) {
      planner.play([click("Book a table"), finish("Booked; the planner goes on.")]);
      const run = await runGoal(session, { url: `${site.url}/settle-table.html`, goal, settings: fresh });
      record.runs.settle[name] = ended(run);
      check(`G50 a goal in ${name} does not settle`, { settled: false, asked: 0 }, { settled: ended(run).settled, asked: ended(run).asked });
    }

    // G50: a step left as a link styled as a button, or as a button that is not in English.
    for (const [name, next, label] of [["a link styled as a button", "settle-review-link.html", "Place order"], ["a German button", "settle-review-de.html", "Jetzt kaufen"]]) {
      planner.play([click("Check out"), click(label, SLOW), finish("Order MS-1 placed.")]);
      const run = await runGoal(session, { url: `${site.url}/settle-cart.html?next=${next}`, goal: "Buy the blue mug.", settings: fresh });
      record.runs.settle[name] = ended(run);
      check(`G50 a review page whose step left is ${name} does not settle`, { done: true, placed: true }, { done: run.done, placed: run.url.includes("settle-placed.html") });
    }

    // G50: a step left that is not a button: an empty field beside a safe button, or an unchecked
    // "I agree" box beside a plain-named link.
    for (const [name, next] of [["an empty field", "settle-review-field.html"], ["an unchecked box", "settle-review-agree.html"]]) {
      planner.play([click("Check out"), finish("The planner reads the page and goes on.")]);
      const run = await runGoal(session, { url: `${site.url}/settle-cart.html?next=${next}`, goal: "Buy the blue mug.", settings: fresh });
      record.runs.settle[name] = ended(run);
      check(`G50 a page with ${name} left does not settle`, { settled: false, asked: 0 }, { settled: ended(run).settled, asked: ended(run).asked });
    }
  } finally {
    await sidebar.evaluate((s) => browser.storage.local.set({ settings: s }), before).catch(() => undefined);
    for (const m of memories) await sidebar.evaluate((t, k) => browser.runtime.sendMessage({ op: "memory-add", text: t, kind: k }), m.text, m.kind);
    await Promise.all([site.close(), planner.close(), helper.close()]);
  }
}
