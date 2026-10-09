// The background page hosts the agent, the trail and the runs. The sidebar
// talks to it over a "foxmate" port: it starts a goal on a tab, answers
// approvals and stops a run. Every open sidebar gets every event of the
// current run, so a sidebar that opens late shows the run too.
import { IdbStore, Log, idbKey } from "foxtrail";
import { createAgent } from "../src/index.ts";

const trailReady = Promise.all([IdbStore.open("foxmate-trail"), idbKey("foxmate-trail-key")]).then(([store, key]) => new Log({ store, key }));
const trail = { append: async (entry) => (await trailReady).append(entry) };
const agent = createAgent({ browser, trail, maxSteps: 30 });

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
    } catch (error) {
      port.postMessage({ error: error instanceof Error ? error.message : String(error) });
    }
  });
});

browser.runtime.onMessage.addListener(async (message) => {
  if (message?.op !== "trail") return undefined;
  const log = await trailReady;
  return { entries: await log.entries(), verify: await log.verify() };
});
