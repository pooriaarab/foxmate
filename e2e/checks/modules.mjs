// O1-O3: the optional modules are off by default, and a tool that is off
// says so. A mail or calendar read asks once per run (G18, G30). With FOXMATE_VISION=<Ollama /v1 address that allows
// moz-extension origins>, the look tool describes a canvas page.
import { serve } from "create-foxkit/e2e";
import { saveShot } from "../lib.mjs";

export default async function modulesCheck({ session, check, record, scripted, finish, runGoal }) {
  const site = await serve("e2e/site");
  try {
    // O2 (G18): the first calendar read of a run asks. Deny ends the run; nothing is read.
    const denied = await runGoal(session, {
      url: `${site.url}/canvas.html`, goal: "List my meetings.", answer: () => "deny",
      settings: scripted([{ tool: "read_calendar", args: {} }, finish, finish]),
    });
    check("O2 the first calendar read asks, and Deny reads nothing", { asked: ["read_calendar"], read: false, end: "Blocked (approval-denied)" },
      { asked: denied.approvals.map((a) => JSON.parse(a.text).tool), read: denied.trail.some((e) => e.kind === "loop.tool-result" && e.data.name === "read_calendar"), end: denied.status.slice(0, 25) });
    const off = await runGoal(session, {
      url: `${site.url}/canvas.html`, goal: "What does this page say?", shot: "chat-mail-ask",
      settings: scripted([{ tool: "look", args: {} }, { tool: "read_calendar", args: {} }, { tool: "read_calendar", args: { max: 3 } }, finish, finish]),
    });
    const results = off.trail.filter((e) => e.kind === "loop.tool-result").map((e) => [e.data.name, e.data.ok, e.data.summary]);
    check("O1 the look tool refuses while screenshots are off", ["look", false, "Screenshots are off. The user can turn them on in Settings."], results[0]);
    check("O2 after one OK, the calendar tools say Google is not connected, and the second read asks nothing",
      { asks: 1, result: ["read_calendar", false, "Google is not connected. The user can connect it in Settings."] }, { asks: off.approvals.length, result: results[1] });

    const vision = process.env.FOXMATE_VISION;
    if (!vision) {
      record.vision = "skipped: set FOXMATE_VISION to an Ollama address that allows moz-extension origins";
      return;
    }
    const on = await runGoal(session, {
      url: `${site.url}/canvas.html`, goal: "What does this page say?", timeoutMs: 300_000, shot: "chat-look",
      settings: { ...scripted([{ tool: "look", args: {} }, finish]), modules: { lens: true, lensURL: vision, lensModel: process.env.FOXMATE_VISION_MODEL ?? "qwen3-vl:2b-instruct" } },
    });
    await session.sidebar.evaluate(async () => {
      window.foxmate.show("settings");
      await new Promise((r) => setTimeout(r, 300));
      document.getElementById("module-lens").scrollIntoView();
    });
    await saveShot(session.sidebar, "settings-modules");
    await session.sidebar.evaluate(() => window.foxmate.show("chat"));
    const seen = on.trail.find((e) => e.kind === "loop.tool-result" && e.data.name === "look");
    record.vision = { status: on.status, summary: seen?.data.summary, steps: on.steps };
    check("O3 with screenshots on, a local vision model describes the canvas page", { ok: true, local: true, done: true }, { ok: seen?.data.ok, local: /\(local\)/.test(seen?.data.summary ?? ""), done: on.done });
  } finally {
    await site.close();
  }
}
