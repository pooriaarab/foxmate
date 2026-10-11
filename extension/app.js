// The foxmate app: one page for the full tab and the sidebar. Chat is
// home; the rail opens the other views. One port goes to the background
// page. Each view is a module. The E2E test drives the same code through
// window.foxmate.
import { activity } from "./activity.js";
import { bridge } from "./bridge-view.js";
import { chat } from "./chat.js";
import { talk } from "./voice.js";
import { lend } from "./lend.js";
import { memory } from "./memory.js";
import { pay } from "./pay.js";
import { modules } from "./modules.js";
import { notices } from "./notices.js";
import { phone } from "./phone.js";
import { safety } from "./safety.js";
import { settings } from "./settings.js";
import { space } from "./space.js";
import { target, targetTab } from "./target.js";
import { today } from "./today.js";

const $ = (id) => document.getElementById(id);
const views = { chat, talk, today, lend, space, memory, activity, settings, safety, phone, modules, notices, pay, bridge, target };
// The port to the background page. Firefox unloads an idle background page
// even while a page has a port open (K1), so the page sends a message
// every 20 s. When the background page restarts anyway, it connects again (K2).
let current;
const port = {
  // A runtime port, not window.postMessage: it takes no target origin.
  // oxlint-disable-next-line unicorn/require-post-message-target-origin
  postMessage: (message) => current.postMessage(message),
  onDisconnect: { addListener: (fn) => disconnected.add(fn) },
};
const disconnected = new Set();
// The background page sends a notice only while no foxmate page is in view (NT1).
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
  for (const button of $("nav").querySelectorAll("button[data-view]")) {
    if (button.dataset.view === name) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  }
  for (const section of document.querySelectorAll("main > section[data-view]")) section.hidden = section.dataset.view !== name;
  document.title = name === "chat" ? "foxmate" : `${name[0].toUpperCase()}${name.slice(1)} · foxmate`;
  views[name]?.shown?.();
}
$("nav").addEventListener("click", (event) => {
  const name = event.target.closest("button[data-view]")?.dataset.view;
  if (name) show(name);
});

// The same page runs in a tab and in the sidebar. The rail button moves it to the other place.
const inSidebar = browser.extension.getViews({ type: "sidebar" }).includes(window);
document.body.dataset.place = inSidebar ? "sidebar" : "tab";
$("dock-toggle").querySelector("span").textContent = inSidebar ? "Open full page" : "Open in sidebar";
$("dock-toggle").addEventListener("click", () => {
  if (inSidebar) browser.runtime.sendMessage({ op: "open-app" });
  else browser.sidebarAction.open();
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
window.foxmate = { port, show, tabFor, target: targetTab, keepAlive: (on) => { keepAlive = on; }, start: (tabId, goal, loanId) => chat.start(tabId, goal, loanId), share: (tabId) => bridge.share(tabId) };
