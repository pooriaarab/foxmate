// The Claude Code bridge in Chat: share the current tab, and the Stop
// switch. The background page owns the native port and the shared tab.
const $ = (id) => document.getElementById(id);
let port;

function render({ on, ready, agent, tab, error }) {
  $("bridge-share").checked = on;
  $("bridge-stop").disabled = !on;
  const where = tab ? `tab ${tab.tabId} on ${tab.host}` : "";
  $("bridge-status").textContent = error || (!on ? "Not shared." : agent ? `Claude Code is connected to ${where}.` : ready ? `Sharing ${where}. Waiting for Claude Code.` : "Starting the foxbridge host…");
}

export const bridge = {
  init(p) {
    port = p;
    $("bridge-share").addEventListener("change", async () => {
      if (!$("bridge-share").checked) return port.postMessage({ op: "bridge-stop" });
      const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
      if (tab?.id !== undefined) bridge.share(tab.id);
    });
    $("bridge-stop").addEventListener("click", () => port.postMessage({ op: "bridge-stop" }));
  },
  share(tabId) {
    port.postMessage({ op: "bridge-share", tabId });
  },
  message(message) {
    if (message.bridge) render(message.bridge);
  },
};
