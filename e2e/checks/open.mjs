// OS1, OS3, OS4, UI8 (open): a goal with no web page open. The run starts
// with no host, asks before it opens a site, opens it in a new tab, and
// works there with that host's grants only. Deny opens nothing. A site that
// redirects to another site gets no grant. Firefox maps the hosts to
// 127.0.0.1; a small server here serves the table page and the redirect.
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { poll } from "create-foxkit/e2e";
import { readTrail, saveShot, setSettings } from "../lib.mjs";

const SITE = "bistrolune.foxopen.test";
const LURE = "lure.foxopen.test";
const AWAY = "evil.foxtrap.test";
export const OPEN_HOSTS = `${SITE},${LURE},${AWAY}`;

function startSite() {
  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    if (url.pathname === "/away") {
      res.writeHead(302, { location: `http://${AWAY}:${server.address().port}/table.html` });
      return res.end();
    }
    const file = { "/table.html": "table.html", "/booked.html": "booked.html" }[url.pathname];
    if (!file) {
      res.writeHead(404);
      return res.end();
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(readFileSync(`e2e/site/${file}`));
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

/** Runs a goal with no tab, answers each card with `answer(card)`, and returns what Chat and the trail show. */
async function noTabRun(sidebar, { goal, settings, answer, shot }) {
  await setSettings(sidebar, settings);
  const before = (await readTrail(sidebar)).entries.length;
  const n = await sidebar.evaluate(() => document.querySelectorAll("#conversation > li").length);
  await sidebar.evaluate((g) => window.foxmate.start(undefined, g), goal);
  const cards = [];
  for (;;) {
    const state = await poll(sidebar, (i) => {
      const run = document.querySelectorAll("#conversation > li")[i];
      if (!run) return null;
      const ask = run.querySelector("li.ask .row button")?.closest("li");
      if (ask) {
        return { ask: {
          requestId: ask.dataset.requestId, exact: ask.querySelector("pre").textContent, site: ask.querySelector(".site")?.textContent,
          line: ask.querySelector(".text")?.textContent, icon: ask.querySelector(".site-icon")?.textContent ?? "",
          buttons: [...ask.querySelectorAll(".row button")].map((b) => b.textContent),
        } };
      }
      const end = run.querySelector(".end");
      return end ? { end: end.textContent, done: end.classList.contains("done") } : null;
    }, n, 60_000).catch(async (error) => {
      // Say what Chat shows, so a stuck run names its last step.
      const shown = await sidebar.evaluate(() => `${document.getElementById("status").textContent} | ${document.querySelector("#conversation > li:last-child")?.textContent ?? "no run"}`);
      throw new Error(`${error.message.split("\n")[0]} Chat shows: ${shown.slice(-600)}`);
    });
    if (state.end) {
      const steps = await sidebar.evaluate((i) => [...document.querySelectorAll("#conversation > li")[i].querySelectorAll(".steps li")].map((li) => li.textContent), n);
      const entries = (await readTrail(sidebar)).entries.slice(before).map((e) => ({ kind: e.kind, data: e.data }));
      return { ...state, cards, steps, trail: entries };
    }
    const card = { ...state.ask, tool: JSON.parse(state.ask.exact).tool };
    cards.push(card);
    if (shot && cards.length === 1) await saveShot(sidebar, shot);
    await sidebar.evaluate((id, a) => document.querySelector(`li.ask[data-request-id="${id}"] button[data-answer="${a}"]`).click(), card.requestId, answer(card));
  }
}

const tabsOn = (sidebar, host) => sidebar.evaluate(async (h) => (await browser.tabs.query({})).filter((t) => t.url?.includes(`//${h}:`)).map((t) => t.id), host);

export default async function openCheck({ session, check, record, scripted, finish }) {
  const { sidebar } = session;
  const server = await startSite();
  const port = server.address().port;
  const table = `http://${SITE}:${port}/table.html`;
  try {
    // OS1, OS3, UI8: Approve opens the site in a new tab; the run books there with that host's grants.
    const book = scripted([{ tool: "open_site", args: { url: table } }, { tool: "snapshot", args: {} }, { tool: "click", args: { controlId: "{{control:Book a table}}" } }, finish]);
    const yes = await noTabRun(sidebar, { goal: "Book a table for 4 at Bistro Lune tonight", settings: book, answer: () => "approve", shot: "chat-no-tab-open-site" });
    const first = yes.cards[0];
    const opened = yes.trail.find((e) => e.kind === "run.open-site")?.data;
    const clicks = yes.trail.filter((e) => e.kind === "loop.decision" && e.data.action?.tool === "click").map((e) => e.data.action.domain);
    const booked = await sidebar.evaluate(async (h) => (await browser.tabs.query({})).some((t) => t.url?.includes(`//${h}:`) && t.url.includes("booked.html")), SITE);
    record.runs.open = { yes: { end: yes.end, steps: yes.steps } };
    check("OS1 with no tab, the run asks before it opens the site, on the simple card with no Always allow",
      { tool: "open_site", site: SITE, line: "Open this site in a new tab", buttons: ["Deny", "Approve"], icon: "B", exact: true },
      first && { tool: first.tool, site: first.site, line: first.line, buttons: first.buttons, icon: first.icon, exact: first.exact.includes(table) });
    check("OS3 after Approve, the run works on the new tab with that host's grants and books",
      { asks: ["open_site", "click"], opened: { host: SITE, loaded: SITE, granted: true }, clicks: [SITE, SITE], booked: true, done: true },
      { asks: yes.cards.map((c) => c.tool), opened, clicks, booked, done: yes.done });
    for (const id of await tabsOn(sidebar, SITE)) await sidebar.evaluate((t) => browser.tabs.remove(t), id);

    // OS1: Deny opens nothing, and the run ends.
    const no = await noTabRun(sidebar, { goal: "Book a table at Bistro Lune", settings: book, answer: () => "deny" });
    check("OS1 Deny opens no tab, and the run ends", { asks: 1, tabs: 0, end: "Blocked (approval-denied)" }, { asks: no.cards.length, tabs: (await tabsOn(sidebar, SITE)).length, end: no.end.slice(0, 25) });

    // OS4: the approved site redirects to another site; that site gets no grant.
    const lure = scripted([{ tool: "open_site", args: { url: `http://${LURE}:${port}/away` } }, { tool: "snapshot", args: {} }, finish, finish]);
    const away = await noTabRun(sidebar, { goal: "Book a table", settings: lure, answer: () => "approve" });
    const went = away.trail.find((e) => e.kind === "run.open-site")?.data;
    const allowedAway = away.trail.filter((e) => e.kind === "loop.decision" && e.data.decision === "allow" && e.data.action?.domain === AWAY).length;
    check("OS4 a redirect to another site gets no grant, and the run does not work there",
      { opened: { host: LURE, loaded: AWAY, granted: false }, result: false, allowedAway: 0, done: false },
      { opened: went, result: away.trail.find((e) => e.kind === "loop.tool-result" && e.data.name === "open_site")?.data.ok, allowedAway, done: away.done });
    for (const id of await tabsOn(sidebar, AWAY)) await sidebar.evaluate((t) => browser.tabs.remove(t), id);
  } finally {
    // oxlint-disable-next-line unicorn/require-post-message-target-origin -- a runtime port, not window.postMessage
    await sidebar.evaluate(() => window.foxmate.port.postMessage({ op: "stop" })).catch(() => undefined);
    await new Promise((r) => server.close(r));
  }
}
