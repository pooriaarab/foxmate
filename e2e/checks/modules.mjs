// O1-O3: the optional modules are off by default, and a tool that is off
// says so. With FOXMATE_VISION=<Ollama /v1 address that allows
// moz-extension origins>, the look tool describes a canvas page.
import { serve } from "create-foxkit/e2e";
import { saveShot } from "../lib.mjs";

export default async function modulesCheck({ session, check, record, scripted, finish, runGoal }) {
  const site = await serve("e2e/site");
  try {
    const off = await runGoal(session, {
      url: `${site.url}/canvas.html`, goal: "What does this page say?",
      settings: scripted([{ tool: "look", args: {} }, { tool: "read_calendar", args: {} }, finish, finish]),
    });
    const results = off.trail.filter((e) => e.kind === "loop.tool-result").map((e) => [e.data.name, e.data.ok, e.data.summary]);
    check("O1 the look tool refuses while screenshots are off", ["look", false, "Screenshots are off. The user can turn them on in Settings."], results[0]);
    // O2 (G18): with no opt-in, the gate does not grant the mail tools on a web tab at all.
    const decisions = off.trail.filter((e) => e.kind === "loop.decision").map((e) => [e.data.action?.tool, e.data.decision, e.data.reason]);
    check("O2 without the goal's opt-in, the Google tools get no grant on a web tab", ["read_calendar", "deny", "no-grant"], decisions.find((d) => d[0] === "read_calendar"));
    await session.sidebar.evaluate(() => { document.getElementById("allow-private").checked = true; });
    const opted = await runGoal(session, { url: `${site.url}/canvas.html`, goal: "List my meetings.", settings: scripted([{ tool: "read_calendar", args: {} }, finish, finish]) });
    await session.sidebar.evaluate(() => { document.getElementById("allow-private").checked = false; });
    const optedResult = opted.trail.find((e) => e.kind === "loop.tool-result")?.data;
    check("O2 with the opt-in, the Google tools refuse while Google is not connected", ["read_calendar", false, "Google is not connected. The user can connect it in Settings."], [optedResult?.name, optedResult?.ok, optedResult?.summary]);

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
