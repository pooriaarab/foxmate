// The sidebar: a nav over views, and one port to the background page.
// Each view is a module. The E2E test drives the same code through
// window.foxmate.
import { activity } from "./activity.js";
import { chat } from "./chat.js";
import { settings } from "./settings.js";

const $ = (id) => document.getElementById(id);
const views = { chat, activity, settings };
const port = browser.runtime.connect({ name: "foxmate" });

function show(name) {
  for (const button of $("nav").querySelectorAll("button")) button.setAttribute("aria-pressed", String(button.dataset.view === name));
  for (const section of document.querySelectorAll("section[data-view]")) section.hidden = section.dataset.view !== name;
  views[name]?.shown?.();
}
$("nav").addEventListener("click", (event) => {
  const name = event.target.closest("button")?.dataset.view;
  if (name) show(name);
});

for (const view of Object.values(views)) view.init?.(port);
port.onMessage.addListener((message) => {
  for (const view of Object.values(views)) view.message?.(message);
});

/** The id of the newest tab whose address starts with `prefix`. */
async function tabFor(prefix) {
  const tab = (await browser.tabs.query({})).findLast((t) => t.url?.startsWith(prefix));
  if (!tab) throw new Error(`No tab at ${prefix}`);
  return tab.id;
}

show("chat");
window.foxmate = { port, show, tabFor, start: (tabId, goal) => chat.start(tabId, goal) };
