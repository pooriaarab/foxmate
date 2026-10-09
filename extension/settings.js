// The Settings view: the privacy switch and the planner. Private mode
// lists only planners on this computer or in Firefox. The own key goes to
// foxvault in the background page; the sidebar never stores it.
import { PLANNERS, providerHost } from "../src/planners.ts";

const $ = (id) => document.getElementById(id);
const DEFAULT_SCRIPT = JSON.stringify([{ tool: "snapshot", args: {} }, { tool: "finish", args: { summary: "I read the page." } }], null, 1);
let current = {};
let consentClicked = false;
let port;

function badge() {
  const cloud = current.privacy === "own-key";
  $("privacy").textContent = cloud ? "Own key" : "Private";
  $("privacy").className = cloud ? "badge cloud" : "badge";
}

function render() {
  const privacy = current.privacy ?? "private";
  for (const radio of document.querySelectorAll('input[name="privacy"]')) radio.checked = radio.value === privacy;
  $("privacy-hint").textContent = privacy === "private"
    ? "Page text stays on this computer. foxmind refuses any cloud model, also an Ollama model that ends in -cloud."
    : "Page text goes to the provider you pick, after you and Firefox allow it.";
  const offered = PLANNERS.filter((p) => privacy === "own-key" || !p.cloud);
  $("planner").replaceChildren(...offered.map((p) => new Option(p.label, p.id)));
  const planner = offered.find((p) => p.id === current.planner) ?? offered[0];
  $("planner").value = planner.id;
  $("planner-hint").textContent = planner.hint;
  $("model").value = current.model ?? "";
  $("model").placeholder = planner.model ?? "the server's model";
  $("base-url").value = current.baseURL ?? "";
  $("base-url").placeholder = planner.baseURL ?? "the provider's address";
  $("consent").checked = Boolean(current.consent);
  $("script").value = current.script || DEFAULT_SCRIPT;
  for (const div of document.querySelectorAll("[data-for]")) div.hidden = !div.dataset.for.split(" ").includes(planner.id);
  badge();
}

async function save() {
  const privacy = document.querySelector('input[name="privacy"]:checked')?.value ?? "private";
  const planner = privacy !== current.privacy && privacy === "private" && PLANNERS.find((p) => p.id === $("planner").value)?.cloud ? "saluki" : $("planner").value;
  const baseURL = $("base-url").value.trim();
  // The consent holds for the host it was given for; a new host clears the box (B13).
  const host = providerHost({ planner, baseURL });
  const consent = $("consent").checked && privacy === "own-key" && (current.consentHost === host || consentClicked);
  consentClicked = false;
  current = { ...current, privacy, planner, model: $("model").value.trim(), baseURL, consent, consentHost: consent ? host : undefined, script: $("script").value };
  await browser.storage.local.set({ settings: current });
  render();
}

async function load() {
  ({ settings: current = {} } = await browser.storage.local.get("settings"));
  render();
}

export const settings = {
  init(p) {
    port = p;
    $("nav").closest("body").querySelector('section[data-view="settings"]').addEventListener("change", (event) => {
      if (event.target.id !== "api-key" && !event.target.closest("#phone-panel, #lens-panel, #google-panel") && !event.target.id.startsWith("module-")) save();
    });
    $("consent").addEventListener("click", async () => {
      if (!$("consent").checked) return;
      // Firefox's own consent prompt for page text. An error counts as no.
      const granted = await browser.permissions.request({ data_collection: ["websiteContent"] }).catch(() => false);
      if (!granted) $("consent").checked = false;
      consentClicked = granted;
      await save();
    });
    $("save-key").addEventListener("click", () => {
      port.postMessage({ op: "set-key", key: $("api-key").value, planner: $("planner").value, baseURL: $("base-url").value.trim() });
      $("api-key").value = "";
      $("key-status").textContent = "Saving the key…";
    });
    browser.storage.onChanged.addListener((changes, area) => {
      if (area === "local" && changes.settings) load();
    });
    load();
  },
  shown: load,
  message(message) {
    if (message.keyError) $("key-status").textContent = `The key was not saved: ${message.keyError}`;
    if (message.keySaved) $("key-status").textContent = `The key is in foxvault, for ${message.keySaved} only.`;
  },
};
