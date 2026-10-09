// The background page hosts the agent, the trail and the runs. The sidebar
// talks to it over a "foxmate" port: it starts a goal on a tab, answers
// approvals and stops a run. Every open sidebar gets every event of the
// current run, so a sidebar that opens late shows the run too.
import { storageAreaStore } from "foxgate";
import { createMemory, indexedDbStore } from "foxmemory";
import { createMind } from "foxmind";
import { IdbStore, Log, idbKey } from "foxtrail";
import { attachHeaderInjection, createVault, indexedDbKeyStore } from "foxvault";
import { KEY_HANDLE, createAgent } from "../src/index.ts";

const trailReady = Promise.all([IdbStore.open("foxmate-trail"), idbKey("foxmate-trail-key")]).then(([store, key]) => new Log({ store, key }));
const trail = { append: async (entry) => (await trailReady).append(entry) };
// The in-browser models load on first use. Memories are private: the
// embedder runs in Firefox only, with foxmind's only: ["browser"].
const browserModel = () => import("./browser-model.js");
let embedder;
const memory = createMemory({
  store: indexedDbStore("foxmate-memory"),
  embedder: {
    async embed(texts) {
      embedder ??= browserModel().then(({ transformers }) => createMind({ providers: [transformers({ task: "embed" })], only: ["browser"] }));
      return (await embedder).embed(texts);
    },
  },
});
const agent = createAgent({ browser, trail, memory, maxSteps: 30, browserModel: async () => (await browserModel()).transformers({ task: "chat" }) });
// The own key lives in foxvault. foxvault puts it in the request header as
// the request leaves Firefox, for the key's host only.
const vault = createVault({ store: storageAreaStore(browser.storage.local), keyStore: indexedDbKeyStore("foxmate-vault") });
attachHeaderInjection(vault, browser);

/** Stores the own key for the planner's host, with its header rule. Returns the host. */
async function setKey({ key, planner, baseURL }) {
  const anthropic = planner === "anthropic";
  const host = new URL(baseURL || (anthropic ? "https://api.anthropic.com" : "https://api.openai.com/v1")).hostname;
  if ((await vault.status()) === "new") await vault.initialize();
  await vault.unlock();
  if ((await vault.list()).some((s) => s.handle === KEY_HANDLE)) await vault.remove(KEY_HANDLE);
  await vault.set(KEY_HANDLE, key, { domains: [host] });
  await vault.injectHeader({ handle: KEY_HANDLE, header: anthropic ? "x-api-key" : "Authorization", hosts: [host], format: anthropic ? "{secret}" : "Bearer {secret}" });
  return host;
}

const ports = new Set();
/** The newest run: { id, goal, tabId, events, end, controller }. */
let current;

const send = (message) => {
  for (const port of ports) {
    try {
      port.postMessage(message);
    } catch {
      ports.delete(port);
    }
  }
};

agent.approvals.onChange((waiting) => send({ waiting }));

/** Starts a goal on a tab. Returns the run id, or throws when a run is in progress. */
async function startRun({ goal, tabId }) {
  if (agent.busy) throw new Error("A run is in progress. Stop it first.");
  const { settings = {} } = await browser.storage.local.get("settings");
  // Device mode unlocks without a passphrase; the header rule needs it unlocked.
  if (settings.privacy === "own-key" && (await vault.status()) === "locked") await vault.unlock();
  const run = { id: crypto.randomUUID(), goal, tabId, events: [], controller: new AbortController() };
  current = run;
  send({ run: { id: run.id, goal } });
  const onEvent = (event) => {
    run.events.push(event);
    send({ runId: run.id, event });
  };
  agent.run({ goal, tabId, settings, signal: run.controller.signal, onEvent })
    .catch((error) => ({ status: "blocked", reason: "error", message: error instanceof Error ? error.message : String(error) }))
    .then((end) => {
      run.end = end;
      send({ runId: run.id, end });
    });
  return run.id;
}

browser.action.onClicked.addListener(() => browser.sidebarAction.toggle());

browser.runtime.onConnect.addListener((port) => {
  if (port.name !== "foxmate") return;
  ports.add(port);
  if (current) port.postMessage({ run: { id: current.id, goal: current.goal }, events: current.events, end: current.end });
  port.postMessage({ waiting: agent.approvals.waiting() });
  port.onDisconnect.addListener(() => ports.delete(port));
  port.onMessage.addListener(async (message) => {
    try {
      if (message.op === "run") await startRun(message);
      else if (message.op === "answer") await agent.approvals.answer(message.requestId, message.answer, "sidebar");
      else if (message.op === "stop") current?.controller.abort();
      else if (message.op === "set-key") {
        const saved = await setKey(message).then((host) => ({ keySaved: host }), (error) => ({ keyError: error.message }));
        port.postMessage(saved);
      }
    } catch (error) {
      port.postMessage({ error: error instanceof Error ? error.message : String(error) });
    }
  });
});

browser.runtime.onMessage.addListener(async (message) => {
  if (message?.op === "trail") {
    const log = await trailReady;
    return { entries: await log.entries(), verify: await log.verify() };
  }
  if (message?.op === "memory-list") return { memories: await memory.list() };
  // The Memory page is the user's own hand, so its memories have the source "user".
  if (message?.op === "memory-add") return memory.remember(message.text, { kind: message.kind, source: "user" }).then(({ memory: m }) => ({ memory: m }), (error) => ({ error: error.message }));
  if (message?.op === "memory-update") return memory.update(message.id, message.patch).then((m) => ({ memory: m }), (error) => ({ error: error.message }));
  if (message?.op === "memory-forget") return { forgot: await memory.forget(message.id) };
  if (message?.op === "trail-export") return { jsonl: await (await trailReady).exportJsonl() };
  return undefined;
});
