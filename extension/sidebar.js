// The sidebar: a nav over views, and one port to the background page.
// Each view is a module. The E2E test drives the same code through
// window.foxmate.
import { activity } from "./activity.js";
import { bridge } from "./bridge-view.js";
import { chat } from "./chat.js";
import { talk } from "./voice.js";
import { lend } from "./lend.js";
import { logins } from "./logins.js";
import { memory } from "./memory.js";
import { pay } from "./pay.js";
import { modules } from "./modules.js";
import { notices } from "./notices.js";
import { phone } from "./phone.js";
import { settings } from "./settings.js";
import { space } from "./space.js";
import { today } from "./today.js";

const $ = (id) => document.getElementById(id);
const views = { chat, talk, today, lend, space, memory, activity, settings, phone, modules, notices, pay, bridge, logins };
// The port to the background page. Firefox unloads an idle background page
// even while a sidebar has a port open (K1), so the sidebar sends a message
// every 20 s. When the page restarts anyway, the sidebar connects again (K2).
let current;
const port = {
  // A runtime port, not window.postMessage: it takes no target origin.
  // oxlint-disable-next-line unicorn/require-post-message-target-origin
  postMessage: (message) => current.postMessage(message),
  onDisconnect: { addListener: (fn) => disconnected.add(fn) },
};
const disconnected = new Set();
// The background page sends a notice only while no sidebar is in view (NT1).
// A runtime port, not window.postMessage: it takes no target origin.
// oxlint-disable-next-line unicorn/require-post-message-target-origin
const seen = () => current?.postMessage({ op: "seen", visible: document.visibilityState === "visible" });
document.addEventListener("visibilitychange", seen);
function connect() {
  current = browser.runtime.connect({ name: "foxmate" });
  seen();
  current.onMessage.addListener((message) => {
    for (const view of Object.values(views)) view.message?.(message);
  });
  current.onDisconnect.addListener(() => {
    for (const fn of disconnected) fn();
    setTimeout(connect, 300);
  });
}
let keepAlive = true;
setInterval(() => {
  if (!keepAlive) return;
  try {
    port.postMessage({ op: "ping" });
  } catch {
    // The port is down; connect() runs again.
  }
}, 20_000);

function show(name) {
  for (const button of $("nav").querySelectorAll("button")) button.setAttribute("aria-pressed", String(button.dataset.view === name));
  for (const section of document.querySelectorAll("section[data-view]")) section.hidden = section.dataset.view !== name;
  views[name]?.shown?.();
}
$("nav").addEventListener("click", (event) => {
  const name = event.target.closest("button")?.dataset.view;
  if (name) show(name);
});

for (const view of Object.values(views)) view.init?.(port, { show });
connect();

/** The id of the newest tab whose address starts with `prefix`. */
async function tabFor(prefix) {
  const tab = (await browser.tabs.query({})).findLast((t) => t.url?.startsWith(prefix));
  if (!tab) throw new Error(`No tab at ${prefix}`);
  return tab.id;
}

show("chat");
// keepAlive(false) is for the E2E test of K2: it lets Firefox unload the background page.
window.foxmate = { port, show, tabFor, keepAlive: (on) => { keepAlive = on; }, start: (tabId, goal, loanId) => chat.start(tabId, goal, loanId), share: (tabId) => bridge.share(tabId) };
