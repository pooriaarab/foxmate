// The background page hosts the agent, the trail and the runs. The sidebar
// talks to it over a "foxmate" port: it starts a goal on a tab, answers
// approvals and stops a run. Every open sidebar gets every event of the
// current run, so a sidebar that opens late shows the run too.
import { storageAreaStore } from "foxgate";
import { idbStore, iframeRuntime, openDen } from "foxden";
import { createFoxlend, withDefaultRule } from "foxlend";
import { createMemory, indexedDbStore } from "foxmemory";
import { createMind } from "foxmind";
import { createRunner, storageAreaStore as runnerStore } from "foxrunner";
import { IdbStore, Log, idbKey } from "foxtrail";
import { attachHeaderInjection, createVault, indexedDbKeyStore } from "foxvault";
import { KEY_HANDLE, SPACE_DOMAIN, createAgent, spaceTool } from "../src/index.ts";

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
// The Space: a foxden den in a sandbox page with no network. It opens on
// first use, and its files stay in IndexedDB.
let den;
const space = () => (den ??= openDen({ name: "space", store: idbStore("foxmate-space"), runtime: iframeRuntime({ denUrl: "/den/den.html", pyodideUrl: "/pyodide/" }) }).catch((error) => {
  den = undefined;
  throw error;
}));

// foxgate and foxlend share one public suffix rule and one gate host.
const publicSuffix = withDefaultRule(browser.publicSuffix);
const agent = createAgent({ browser, trail, memory, publicSuffix, maxSteps: 30, extraTools: [{ tool: spaceTool(space), domain: SPACE_DOMAIN }], browserModel: async () => (await browserModel()).transformers({ task: "chat" }) });
// Lend a login: foxlend copies one site's cookies into its own container,
// blocks every request from it to a host off the allow list, and takes it
// all back on revoke. Created at the top level, so Firefox can wake the page.
const lender = createFoxlend({ browser, host: agent.host, publicSuffix });
const blocked = [];
// A blocked URL can carry what the page tried to steal (a cookie in the query),
// so the log and the sidebar keep only its origin and path.
const bare = (url) => {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return "(not a URL)";
  }
};
lender.onBlocked.addListener((event) => {
  const b = { ...event, url: bare(event.url) };
  blocked.push(b);
  blocked.splice(0, blocked.length - 50);
  trail.append({ actor: "foxlend", kind: "lend.blocked", data: { loanId: b.loanId, url: b.url, type: b.type, layer: b.layer, reason: b.reason } }).catch(() => undefined);
  send({ blocked: b });
});
lender.onRevoked.addListener(({ loan, reason }) => {
  trail.append({ actor: "foxlend", kind: "lend.revoke", data: { loanId: loan.id, domain: loan.domain, reason } }).catch(() => undefined);
  send({ loansChanged: true });
});

async function lend({ domain, url, scope, ttlMs, allow }) {
  const loan = await lender.lend({ domain, url, scope, ttlMs, allow });
  await trail.append({ actor: "user", kind: "lend.start", data: { loanId: loan.id, domain: loan.domain, scope, ttlMs, allow: loan.patterns, copied: loan.copied } });
  send({ loansChanged: true });
  return loan;
}

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

/** Runs a goal on a tab now and resolves with its end. Throws "busy" when a run is in progress. */
async function runNow({ goal, tabId, loanId, taskId, signal }) {
  if (agent.busy) throw new Error("busy");
  const { settings = {} } = await browser.storage.local.get("settings");
  // Device mode unlocks without a passphrase; the header rule needs it unlocked.
  if (settings.privacy === "own-key" && (await vault.status()) === "locked") await vault.unlock();
  // A run on a loan works in the loan's tab, with the loan's scope at most.
  const loan = loanId ? (await lender.listLoans()).find((l) => l.id === loanId && l.state === "active") : undefined;
  if (loanId && !loan) return { status: "refused", reason: "no-loan", message: "That loan is not active." };
  if (loan) tabId = loan.tabId;
  const run = { id: crypto.randomUUID(), taskId, goal, tabId, events: [], controller: new AbortController() };
  signal?.addEventListener("abort", () => run.controller.abort(), { once: true });
  current = run;
  send({ run: { id: run.id, goal } });
  const onEvent = (event) => {
    run.events.push(event);
    send({ runId: run.id, event });
  };
  const end = await agent.run({ goal, tabId, settings, signal: run.controller.signal, onEvent, ...(loan ? { loan: { cookieStoreId: loan.cookieStoreId, scope: loan.scope } } : {}) })
    .catch((error) => ({ status: "blocked", reason: "error", message: error instanceof Error ? error.message : String(error) }));
  run.end = end;
  send({ runId: run.id, end });
  if (agent.approvals.waiting().length === 0 && end.status !== "done" && !ports.size) notify(`foxmate stopped: ${end.message ?? end.status}`);
  return end;
}

const notify = (message) => browser.notifications.create({ type: "basic", title: "foxmate", message }).catch(() => undefined);

// Every goal is a foxrunner task, so a run that the event page unload cuts
// short runs again at the next wake (at least once, from the goal). A
// scheduled task opens its page in a new tab first.
const runner = createRunner({ store: runnerStore(browser.storage.local), browser });
runner.define("goal", [{
  name: "run",
  retry: { maxAttempts: 4, backoffMs: 30_000 },
  async run(ctx) {
    const input = ctx.input;
    let tabId = input.tabId;
    if (input.url) {
      tabId = (await browser.tabs.create({ url: input.url, active: false })).id;
      // A new tab reports about:blank as complete before it starts to load the page.
      const loaded = async () => {
        const tab = await browser.tabs.get(tabId);
        return tab.status === "complete" && tab.url?.startsWith("http");
      };
      for (let i = 0; i < 75 && !(await loaded()); i++) await new Promise((r) => setTimeout(r, 200));
    }
    const end = await runNow({ goal: input.goal, tabId, loanId: input.loanId, taskId: ctx.taskId, signal: ctx.signal });
    return { ...end, attempt: ctx.attempt };
  },
}]);
agent.approvals.onChange((waiting) => {
  if (waiting.length && !ports.size) notify("foxmate waits for your approval. Open the sidebar.");
});

browser.action.onClicked.addListener(() => browser.sidebarAction.toggle());

browser.runtime.onConnect.addListener((port) => {
  if (port.name !== "foxmate") return;
  ports.add(port);
  if (current) port.postMessage({ run: { id: current.id, goal: current.goal }, events: current.events, end: current.end });
  port.postMessage({ waiting: agent.approvals.waiting() });
  port.onDisconnect.addListener(() => ports.delete(port));
  port.onMessage.addListener(async (message) => {
    try {
      if (message.op === "run") {
        if (agent.busy) throw new Error("A run is in progress. Stop it first.");
        await runner.start("goal", { goal: message.goal, tabId: message.tabId, ...(message.loanId ? { loanId: message.loanId } : {}) });
      }
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
  if (message?.op === "tasks") return { tasks: (await runner.list()).filter((t) => t.name === "goal").slice(0, 20), schedules: await runner.schedules(), waiting: agent.approvals.waiting().length };
  if (message?.op === "schedule") return runner.schedule("goal", { cron: message.cron, input: { goal: message.goal, url: message.url }, id: `goal-${crypto.randomUUID()}` }).then((schedule) => ({ schedule }), (error) => ({ error: error.message }));
  if (message?.op === "unschedule") return runner.unschedule(message.id).then(() => ({ ok: true }));
  if (message?.op === "cancel-task") return runner.cancel(message.id).then(() => ({ ok: true }));
  if (message?.op === "space-list") return space().then(async (d) => ({ files: await d.list() }), (error) => ({ error: error.message }));
  if (message?.op === "space-write") return space().then(async (d) => ({ ok: await d.writeFile(`/drop/${message.name}`, message.bytes) }), (error) => ({ error: error.message }));
  if (message?.op === "space-delete") return space().then(async (d) => ({ ok: await d.deleteFile(message.path) }), (error) => ({ error: error.message }));
  if (message?.op === "loans") return { loans: await lender.listLoans(), blocked };
  if (message?.op === "lend") return lend(message).then((loan) => ({ loan }), (error) => ({ error: error.message, code: error.code }));
  if (message?.op === "revoke") return lender.revoke(message.loanId).then((ok) => ({ ok }), (error) => ({ error: error.message }));
  if (message?.op === "memory-list") return { memories: await memory.list() };
  // The Memory page is the user's own hand, so its memories have the source "user".
  if (message?.op === "memory-add") return memory.remember(message.text, { kind: message.kind, source: "user" }).then(({ memory: m }) => ({ memory: m }), (error) => ({ error: error.message }));
  if (message?.op === "memory-update") return memory.update(message.id, message.patch).then((m) => ({ memory: m }), (error) => ({ error: error.message }));
  if (message?.op === "memory-forget") return { forgot: await memory.forget(message.id) };
  if (message?.op === "trail-export") return { jsonl: await (await trailReady).exportJsonl() };
  return undefined;
});
