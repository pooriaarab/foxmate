// Settings: the planner. Every planner runs on this computer or in
// Firefox. Approval rules and saved logins live in safety.js.
import { PLANNERS } from "../src/planners.ts";
import { safety } from "./safety.js";

const $ = (id) => document.getElementById(id);
const DEFAULT_SCRIPT = JSON.stringify([{ tool: "snapshot", args: {} }, { tool: "finish", args: { summary: "I read the page." } }], null, 1);
// These fields belong to other modules, which save them on their own.
const OTHERS = "#phone-panel, #lens-panel, #google-panel, #pay-panel, #notice-panel, #login-form";
const OWN = new Set(["planner", "model", "base-url", "script"]);
let current = {};

function render() {
  $("planner").replaceChildren(...PLANNERS.map((p) => new Option(p.label, p.id)));
  const planner = PLANNERS.find((p) => p.id === current.planner) ?? PLANNERS[0];
  $("planner").value = planner.id;
  $("planner-hint").textContent = planner.hint;
  $("model").value = current.model ?? "";
  $("model").placeholder = planner.model ?? "the server's model";
  $("base-url").value = current.baseURL ?? "";
  $("base-url").placeholder = planner.baseURL ?? "the server's address";
  $("script").value = current.script || DEFAULT_SCRIPT;
  for (const div of document.querySelectorAll("[data-for]")) div.hidden = !div.dataset.for.split(" ").includes(planner.id);
}

async function save() {
  current = { ...current, planner: $("planner").value, model: $("model").value.trim(), baseURL: $("base-url").value.trim(), script: $("script").value };
  await browser.storage.local.set({ settings: current });
  render();
}

async function load() {
  ({ settings: current = {} } = await browser.storage.local.get("settings"));
  render();
}

export const settings = {
  init() {
    document.querySelector('section[data-view="settings"]').addEventListener("change", (event) => {
      if (OWN.has(event.target.id) && !event.target.closest(OTHERS)) save();
    });
    browser.storage.onChanged.addListener((changes, area) => {
      if (area === "local" && changes.settings) load();
    });
    load();
  },
  shown() {
    void load();
    void safety.load();
  },
};
