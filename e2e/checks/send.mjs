// U1-U4: a send that foxloop calls unconfirmed (the form came back with a new error signal on the page) fails the
// finish, so a run can no longer report a false success (mail-reply said "Replied" when Postbox refused the To).
// U1 a bad To on Postbox's compose page fails the first finish; U2 the fixed To sends and the run ends Done;
// U3 a good save that draws the same form again ends Done at once; U4 an alert from before the send does not fail
// a good send.
import { serve } from "create-foxkit/e2e";
import { taskById } from "foxbench";

/** Each finish check of a run, as true when foxloop's unconfirmed send failed it. */
const unconfirmed = (run) => run.trail.filter((e) => e.kind === "loop.check").map((e) => e.data.checks.some((c) => c.part === "the send went through" && !c.ok));

/** A fill of the To field on the compose page. */
const to = (value) => ({ tool: "fill", args: { fields: { "{{control:To}}": value } } });

export default async function sendCheck({ session, bench, check, record, scripted, finish, runGoal }) {
  const keep = (name, run) => { record.runs[name] = { status: run.status, approvals: run.approvals, steps: run.steps, checks: unconfirmed(run) }; };
  const task = taskById("mail-reply");
  const compose = new URL("/mail/compose", bench.reset(task)).href;
  const reply = await runGoal(session, {
    url: compose, goal: "Write to Dana Lee that the Q4 budget is approved.", shot: "chat-send-unconfirmed",
    settings: scripted([
      { tool: "snapshot", args: {} },
      { tool: "fill", args: { fields: { "{{control:To}}": "Dana Lee <dana>", "{{control:Subject}}": "Q4 budget", "{{control:Message}}": "It is approved." } } },
      { tool: "click", args: { controlId: "{{control:Send}}" } },
      finish,
      to("dana.lee@northwind.test"),
      { tool: "click", args: { controlId: "{{control:Send}}" } },
      finish,
    ]),
  });
  keep("send-unconfirmed", reply);
  const sent = bench.state.mail.filter((m) => m.folder === "sent").map((m) => m.to);
  check("U1 a send that came back with an error fails the first finish", true, unconfirmed(reply)[0] === true);
  check("U2 the fixed To sends and the run ends Done", { done: true, checks: [true, false], sent: [["dana.lee@northwind.test"]] },
    { done: reply.done, checks: unconfirmed(reply), sent });

  const site = await serve("e2e/site");
  try {
    const saved = await runGoal(session, {
      url: `${site.url}/send-saved.html`, goal: "Save my profile as it is.", shot: "chat-send-saved",
      settings: scripted([{ tool: "snapshot", args: {} }, { tool: "click", args: { controlId: "{{control:Save profile}}" } }, finish]),
    });
    keep("send-saved", saved);
    check("U3 a good save that draws the same form again ends Done at once", { done: true, checks: [false] }, { done: saved.done, checks: unconfirmed(saved) });
    const banner = await runGoal(session, {
      url: `${site.url}/send-banner.html`, goal: "Send the feedback: the app works well.", shot: "chat-send-banner",
      settings: scripted([{ tool: "snapshot", args: {} }, { tool: "act", args: { controlId: "{{control:Your note}}", op: "type", value: "The app works well." } },
        { tool: "click", args: { controlId: "{{control:Send feedback}}" } }, finish]),
    });
    keep("send-banner", banner);
    check("U4 an alert from before the send does not fail a good send", { done: true, checks: [false] }, { done: banner.done, checks: unconfirmed(banner) });
  } finally {
    await site.close?.();
  }
}
