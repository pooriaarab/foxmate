// B1-B3: foxmate uses only models on this computer. Settings offers no cloud
// planner, and a model that runs elsewhere is refused before any plan.
import { saveShot } from "../lib.mjs";

export default async function localCheck({ session, bench, check, runGoal }) {
  const { sidebar } = session;
  const url = `${bench.url}/signup/`;
  const offered = await sidebar.evaluate(async () => {
    await browser.storage.local.set({ settings: {} });
    window.foxmate.show("settings");
    await new Promise((r) => setTimeout(r, 300));
    return [...document.querySelectorAll("#planner option")].map((o) => o.value);
  });
  check("B1 Settings offers only planners on this computer or in Firefox", ["saluki", "ollama", "llama-server", "browser", "scripted"], offered);
  await saveShot(sidebar, "settings-planner");
  await sidebar.evaluate(() => window.foxmate.show("chat"));

  const refused = async (settings) => {
    const run = await runGoal(session, { url, goal: "Sign me up.", settings });
    return { status: run.status.split(":")[0], plans: run.steps.filter((s) => s.startsWith("Plan")).length, trail: run.kinds.includes("run.refused") };
  };
  check("B1 a cloud planner left in old settings is refused before any plan", { status: "Refused (unknown-planner)", plans: 0, trail: true },
    await refused({ planner: "anthropic" }));
  check("B2 an Ollama -cloud model is refused before any plan", { status: "Refused (not-local)", plans: 0, trail: true },
    await refused({ planner: "ollama", model: "gpt-oss:120b-cloud" }));
}
