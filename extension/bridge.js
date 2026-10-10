// The Claude Code bridge (foxbridge). An MCP client drives the ONE tab that
// the user shares from the sidebar. foxmate speaks foxbridge's native
// messaging protocol, so `foxbridge install --extension-id foxmate@pooriaarab`
// lets the foxbridge host start for foxmate. Each call is a run of its own
// through the agent (src/bridge.ts), so foxgate, foxshield and the
// approvals in Chat apply (docs/failure-modes.md BR1-BR8).
import { BridgeRefusal, bridgeCall } from "../src/index.ts";

/** MCP tool name -> foxloop tool name. */
const TOOLS = { snapshot: "snapshot", act: "act", click: "click", run_task: "browser_task", open_url: "open_url" };
const hostOf = (url) => {
  try {
    const u = new URL(url ?? "");
    return u.protocol === "http:" || u.protocol === "https:" ? u.hostname : undefined;
  } catch {
    return undefined;
  }
};

/** `run(tabId, tool, mind, onEvent, signal)` runs one call through the agent. `send` reaches every sidebar. */
export function createBridge({ run, send }) {
  const state = { on: false, ready: false, agent: false, tab: undefined, error: "" };
  const calls = new Map();
  let port;
  const view = () => ({ bridge: { on: state.on, ready: state.ready, agent: state.agent, tab: state.tab, error: state.error } });
  const changed = () => send(view());

  /** The Stop switch: close the port, end what runs or waits, and stop sharing (BR8). */
  function stop(error = "") {
    const p = port;
    port = undefined;
    p?.disconnect();
    for (const controller of calls.values()) controller.abort();
    Object.assign(state, { on: false, ready: false, agent: false, tab: undefined, error });
    changed();
  }

  async function answer(tool, args, signal) {
    const shared = state.tab;
    if (tool === "list_tabs") return { ok: true, summary: `1 shared tab: tab ${shared.tabId} on ${shared.host}.`, untrusted: `tab ${shared.tabId}: ${shared.title}` };
    const name = TOOLS[tool];
    if (!name) throw new BridgeRefusal("unknown-tool", `foxmate has no tool "${tool}".`);
    const { tabId, ...rest } = args ?? {};
    // BR1: one shared tab. open_url names no tab: it opens the address in the shared tab.
    if (tool !== "open_url" && tabId !== shared.tabId) throw new BridgeRefusal("not-shared", `Tab ${String(tabId)} is not shared. foxmate shares tab ${shared.tabId} only.`);
    // BR7: the tab left the host where the user shared it.
    if (hostOf((await browser.tabs.get(shared.tabId).catch(() => ({}))).url) !== shared.host) {
      // Stop after the reply goes out, so the agent reads why.
      setTimeout(() => stop(`The shared tab left ${shared.host}, so foxmate stopped sharing it.`), 0);
      throw new BridgeRefusal("not-shared", `The shared tab left ${shared.host}, so foxmate stopped sharing it.`);
    }
    return bridgeCall((mind, onEvent) => run(shared.tabId, tool, mind, onEvent, signal), { name, args: rest });
  }

  async function handle(p, { id, tool, args }) {
    const controller = new AbortController();
    calls.set(id, controller);
    let reply;
    try {
      reply = { type: "reply", id, ok: true, result: await answer(tool, args, controller.signal) };
    } catch (error) {
      reply = { type: "reply", id, ok: false, error: { code: error?.code ?? "error", message: error?.message ?? String(error) } };
    } finally {
      calls.delete(id);
    }
    // A native port takes no target origin.
    // oxlint-disable-next-line unicorn/require-post-message-target-origin
    if (port === p) p.postMessage(reply);
  }

  /** Shares one tab, and starts the foxbridge host. */
  async function share(tabId) {
    const tab = await browser.tabs.get(tabId);
    const host = hostOf(tab.url);
    if (!host) {
      state.error = "This tab shows no web page.";
      return changed();
    }
    stop();
    Object.assign(state, { on: true, tab: { tabId, host, title: tab.title ?? "" } });
    const p = browser.runtime.connectNative("foxbridge");
    port = p;
    p.onMessage.addListener((m) => {
      if (port !== p || !m || typeof m !== "object") return;
      if (m.type === "ready") state.ready = true;
      else if (m.type === "agent") state.agent = m.connected === true;
      else if (m.type === "host-error") state.error = String(m.message);
      else if (m.type === "call" && typeof m.id === "string") void handle(p, m);
      else if (m.type === "cancel") calls.get(m.id)?.abort();
      if (m.type === "agent" && !state.agent) for (const controller of calls.values()) controller.abort();
      changed();
    });
    p.onDisconnect.addListener(() => {
      if (port !== p) return;
      const why = p.error?.message ?? "";
      stop(state.ready ? `The foxbridge host stopped${why ? `: ${why}` : "."}` : `Firefox could not start the foxbridge host${why ? ` (${why})` : ""}. Run "foxbridge install --extension-id foxmate@pooriaarab".`);
    });
    changed();
  }

  browser.tabs.onRemoved.addListener((tabId) => {
    if (state.tab?.tabId === tabId) stop("The shared tab closed, so foxmate stopped sharing it.");
  });
  return { share, stop, view };
}
