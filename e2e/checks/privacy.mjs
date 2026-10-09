// P1-P6: the privacy switch. Private mode never reaches a cloud model, the
// own key needs two consents, and the key never reaches storage in clear.
import { saveShot } from "../lib.mjs";

const KEY = "sk-test-foxmate-0123456789";

export default async function privacyCheck({ session, bench, check, runGoal }) {
  const { sidebar } = session;
  const url = `${bench.url}/signup/`;
  const settingsOffered = async (value) => sidebar.evaluate(async (v) => {
    await browser.storage.local.set({ settings: { privacy: v } });
    window.foxmate.show("settings");
    await new Promise((r) => setTimeout(r, 300));
    return { planners: [...document.querySelectorAll("#planner option")].map((o) => o.value), badge: document.getElementById("privacy").textContent };
  }, value);
  check("P1 private mode offers no cloud planner", { planners: ["saluki", "ollama", "llama-server", "browser", "scripted"], badge: "Private" }, await settingsOffered("private"));
  await saveShot(sidebar, "settings-private");
  check("P1 own-key mode offers the cloud planners too", { planners: ["saluki", "ollama", "llama-server", "browser", "scripted", "openai", "anthropic"], badge: "Own key" }, await settingsOffered("own-key"));
  await sidebar.evaluate(() => window.foxmate.show("chat"));

  const refused = async (settings) => {
    const run = await runGoal(session, { url, goal: "Sign me up.", settings });
    return { status: run.status.split(":")[0], plans: run.steps.filter((s) => s.startsWith("Plan")).length, trail: run.kinds.includes("run.refused") };
  };
  check("P2 private mode refuses an Ollama -cloud model before any plan", { status: "Refused (cloud-model-in-private)", plans: 0, trail: true },
    await refused({ privacy: "private", planner: "ollama", model: "gpt-oss:120b-cloud" }));
  await saveShot(sidebar, "chat-refused");
  check("P3 the own key needs the consent box", { status: "Refused (no-consent)", plans: 0, trail: true },
    await refused({ privacy: "own-key", planner: "openai", model: "gpt-test", consent: false }));
  check("P4 a ticked box without Firefox's data consent is not enough", { status: "Refused (no-consent)", plans: 0, trail: true },
    await refused({ privacy: "own-key", planner: "openai", model: "gpt-test", consent: true }));
  check("P6 a cloud planner left over in private mode is refused", { status: "Refused (cloud-in-private)", plans: 0, trail: true },
    await refused({ privacy: "private", planner: "anthropic", consent: true }));

  // P5: save a key through the Settings view. Only foxvault's ciphertext may reach storage.
  const saved = await sidebar.evaluate(async (key) => {
    await browser.storage.local.set({ settings: { privacy: "own-key", planner: "openai" } });
    window.foxmate.show("settings");
    await new Promise((r) => setTimeout(r, 300));
    document.getElementById("api-key").value = key;
    document.getElementById("save-key").click();
    for (let i = 0; i < 50 && !/foxvault, for/.test(document.getElementById("key-status").textContent); i++) await new Promise((r) => setTimeout(r, 100));
    const status = document.getElementById("key-status").textContent;
    return { status, field: document.getElementById("api-key").value, storage: JSON.stringify(await browser.storage.local.get(null)) };
  }, KEY);
  await saveShot(sidebar, "settings-own-key");
  await sidebar.evaluate(() => window.foxmate.show("chat"));
  const trail = JSON.stringify((await sidebar.evaluate(() => browser.runtime.sendMessage({ op: "trail" }))).entries);
  check("P5 the key goes to foxvault for its host only, and the field clears", { status: "The key is in foxvault, for api.openai.com only.", field: "" }, { status: saved.status, field: saved.field });
  check("P5 the key is not in storage.local or the trail in clear", { storage: false, trail: false }, { storage: saved.storage.includes(KEY), trail: trail.includes(KEY) });
}
