// NT1-NT8 (notify): foxnotify while no sidebar is in view. The test closes
// the sidebar while the planner waits, reads Firefox's own alert window
// (alerts.useSystemBackend off, in run.mjs), and clicks it in chrome scope,
// as a person does. A stand-in server is the webhook.
import { createServer } from "node:http";
import { poll, serve } from "create-foxkit/e2e";
import { startPlanner } from "../planner.mjs";
import { grant } from "./bridge.mjs";

const GOAL = "Book a table at Bistro Lune for 2";
const onCI = Boolean(process.env.CI);
const hhmm = (ms) => new Date(ms).toTimeString().slice(0, 5);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 20_000) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(250)) {
    const value = await fn().catch(() => null);
    if (value) return value;
  }
  return null;
}

async function startHook() {
  const got = [];
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    if (req.method === "POST") got.push({ type: req.headers["content-type"], body });
    res.writeHead(req.method === "OPTIONS" ? 204 : 200, { "access-control-allow-origin": "*", "access-control-allow-headers": "*" }).end();
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  return { url: `http://127.0.0.1:${server.address().port}/foxmate`, got, close: () => new Promise((done) => server.close(done)) };
}

/** The planner's click on "Book a table", from the newest page read in its request. */
const book = (body) => ({ tool: "click", args: { controlId: /^\[([^\]]+)\].*Book a table/m.exec(JSON.parse(body).messages.findLast((m) => m.role === "tool").content)?.[1] ?? "" } });

/** The title and text of each Firefox alert window. With `click`, a real click on the one with that title. */
async function alerts(fox, click = "") {
  const tree = await fox.browser.connection.send("browsingContext.getTree", { "moz:scope": "chrome" });
  const out = [];
  for (const { context } of tree.result.contexts.filter((c) => c.url.endsWith("/alert.xhtml"))) {
    const expression = `(() => { const text = [document.getElementById("alertTitleLabel").getAttribute("value"), document.getElementById("alertTextLabel").textContent];
      if (text[0] === ${JSON.stringify(click)}) document.getElementById("alertBox").click(); return JSON.stringify(text); })()`;
    const r = await fox.browser.connection.send("script.evaluate", { expression, target: { context }, awaitPromise: true, "moz:scope": "chrome" });
    out.push(JSON.parse(r.result.result.value));
  }
  return out;
}

export default async function notifyCheck({ session, check, record, runGoal }) {
  const { fox } = session;
  // NT8: on CI, a check of what Firefox shows may skip, as in foxnotify.
  const display = (name, expected, actual) => {
    if (JSON.stringify(actual) === JSON.stringify(expected) || !onCI) return check(name, expected, actual);
    (record.skipped ??= []).push({ name, expected, actual });
    console.log(`SKIP (CI) ${name}: Firefox showed no notice on this runner.`);
  };
  const [planner, hook, site] = await Promise.all([startPlanner(), startHook(), serve("e2e/site")]);
  try {
    // NT4-NT7: the notice settings, through the Settings view. Quiet hours start in 2 h, so nothing waits now.
    const quiet = { start: hhmm(Date.now() + 2 * 3_600_000), end: hhmm(Date.now() + 3 * 3_600_000) };
    const set = await session.sidebar.evaluate(async (url, q) => {
      await browser.storage.local.set({ settings: { planner: "scripted" } });
      window.foxmate.show("settings");
      // oxlint-disable-next-line unicorn/consistent-function-scoping -- this function runs in the page
      const field = (id, value) => {
        const el = document.getElementById(id);
        if (el.type === "checkbox") el.checked = value;
        else el.value = value;
        el.dispatchEvent(new Event("change", { bubbles: true }));
      };
      for (const [id, value] of [["notice-quiet-start", q.start], ["notice-quiet-end", q.end], ["notice-quiet", true], ["notice-webhook-url", url], ["notice-webhook", true]]) {
        field(id, value);
        await new Promise((r) => setTimeout(r, 200));
      }
      // A click from a script is no user action, so Firefox refuses the consent prompt.
      document.getElementById("notice-title").click();
      await new Promise((r) => setTimeout(r, 500));
      const stored = await browser.storage.local.get(null);
      window.foxmate.show("chat");
      return { preview: JSON.parse(document.getElementById("notice-preview").textContent), title: document.getElementById("notice-title").checked, notices: stored.settings.notices, planner: stored.settings.planner, rules: stored["fnt:rules"] };
    }, hook.url, quiet);
    check("NT4 quiet hours from Settings reach foxnotify", quiet, set.rules?.quietHours && { start: set.rules.quietHours.start, end: set.rules.quietHours.end });
    check("NT5 the title box stays off without Firefox's websiteActivity consent", false, set.title);
    check("NT6 the preview is the request to the webhook, with no title", { url: hook.url, method: "POST", title: false }, { url: set.preview.url, method: set.preview.method, title: JSON.stringify(set.preview.body).includes("Bistro") });
    check("NT7 a notice setting keeps the other settings", { planner: "scripted", webhook: true }, { planner: set.planner, webhook: set.notices?.webhook });

    // NT1: an approval waits while the sidebar is closed.
    const settings = { ...(await session.sidebar.evaluate(async () => (await browser.storage.local.get("settings")).settings)), planner: "llama-server", baseURL: planner.url, model: "fake" };
    await session.sidebar.evaluate((s) => browser.storage.local.set({ settings: s }), settings);
    planner.play([{ tool: "snapshot" }, book, { tool: "finish", args: { summary: "Booked." } }], { hold: true });
    const page = await fox.open(`${site.url}/table.html`);
    await session.sidebar.evaluate(async (u, g) => window.foxmate.start(await window.foxmate.tabFor(u), g), page.url(), GOAL);
    await until(async () => planner.bodies.length > 0);
    await session.sidebar.close();
    planner.release();
    const shown = await until(async () => (await alerts(fox)).find((a) => a[0] === "Approval needed"));
    display("NT1 Firefox shows the approval notice", ["Approval needed", `${GOAL}: an action waits for you. Click to review it.`], shown);

    // NT2: the click opens the approval in a tab. It approves nothing.
    if (shown) await alerts(fox, "Approval needed");
    const opened = await until(async () => {
      for (const p of await fox.browser.pages()) if (await p.evaluate(() => location.href.endsWith("/app.html#approval")).catch(() => false)) return p;
      return null;
    }, 10_000);
    display("NT2 a click on the notice opens the approval page", true, Boolean(opened));
    const sidebar = opened ?? (await fox.openExtensionPage("app.html#approval"));
    session.sidebar = sidebar;
    await poll(sidebar, () => Boolean(window.foxmate));
    const waits = await poll(sidebar, async () => {
      const ask = [...document.querySelectorAll("li.ask")].findLast((li) => li.querySelector(".row button"));
      return ask && { buttons: [...ask.querySelectorAll("button")].map((b) => b.textContent), waiting: (await browser.runtime.sendMessage({ op: "tasks" })).waiting };
    });
    check("NT2 the approval still waits for Approve or Deny, and the click did not run", { buttons: ["Approve", "Deny"], waiting: 1, requests: 2 }, { ...waits, requests: planner.bodies.length });

    // NT3: with no sidebar in view, a finished run waits in the digest.
    await page.bringToFront();
    await sidebar.evaluate(() => [...document.querySelectorAll("li.ask .row button")].find((b) => b.dataset.answer === "approve").click());
    const end = await poll(sidebar, () => [...document.querySelectorAll("#conversation .end")].at(-1)?.textContent ?? null, undefined, 60_000);
    const state = await sidebar.evaluate(async () => (await browser.storage.local.get("fnt:state"))["fnt:state"]);
    check("NT3 the run ends done, and its notice waits in the digest", { end: "Done: Booked.", queued: true }, { end, queued: state.queue.some((n) => n.kind === "task-done" && n.title === GOAL) });

    // NT5: the webhook got the approval with no title. A title needs the box and Firefox's consent.
    const first = hook.got[0];
    check("NT5 the webhook gets the approval notice with no title", { kind: "needs-approval", title: false }, first && { kind: JSON.parse(first.body).kind, title: first.body.includes("Bistro") });
    check("NT6 the webhook body has the keys and type of the preview", { keys: Object.keys(set.preview.body), type: set.preview.headers["Content-Type"] }, first && { keys: Object.keys(JSON.parse(first.body)), type: first.type });
    const stuck = async () => {
      const count = hook.got.length;
      await runGoal(session, { page, goal: GOAL, settings: { ...settings, notices: { ...settings.notices, webhookTitle: true }, planner: "no-such-planner" } });
      return (await until(async () => hook.got[count]))?.body ?? "";
    };
    check("NT5 with the title box set but no consent, the webhook gets no title", false, (await stuck()).includes("Bistro"));
    await grant(fox, { permissions: [], data_collection: ["websiteActivity"] });
    check("NT5 after Firefox's consent, the webhook gets the goal as the title", true, (await stuck()).includes(GOAL));
    record.runs.notify = { hook: hook.got.map((g) => JSON.parse(g.body)) };
    await sidebar.evaluate(async () => browser.storage.local.set({ settings: { ...(await browser.storage.local.get("settings")).settings, notices: {} } }));
    await page.close();
  } finally {
    await Promise.all([planner.close(), hook.close(), site.close()]);
  }
}
