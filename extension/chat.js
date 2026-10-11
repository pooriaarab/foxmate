// Chat: the one conversation. Each run is a goal bubble and a list of
// compact steps: the planner, each plan, gate decision and result, inline
// approvals, sign-in waits, and the end. Each step says what happens in
// plain words; the raw tool call sits behind "Details". The fox follows the
// run state. The E2E driver reads this DOM: #conversation > li, .goal,
// .steps li (the label first), li.ask with pre, .detail and
// .row button[data-answer], and .end.
import { logins, rules } from "./engine.js";
import { runState, setRunState } from "./fox.js";
import { details, plain } from "./plain.js";
import { hostOf, targetTab } from "./target.js";

const $ = (id) => document.getElementById(id);
const LONG = 160;
let port;
let steps;
let runHost = "";
// A port that connects again gets the current run once more; show it once.
const shown = new Set();

const STATUS = { thinking: () => "Thinking…", working: () => (runHost ? `Working on ${runHost}…` : "Working…"), "needs-approval": () => "Waiting for your OK" };

function state(next, text) {
  setRunState(next);
  if (text ?? STATUS[next]) $("status").textContent = text ?? STATUS[next]();
}

/** One step: a label, plain text, and the raw text behind "Details" when there is any. */
function line(kind, text, className = "", raw = "") {
  const li = document.createElement("li");
  li.className = className;
  const label = document.createElement("span");
  label.className = "kind";
  label.textContent = kind;
  const body = document.createElement("span");
  body.className = "text";
  body.textContent = text;
  li.append(label, body);
  if (raw) li.append(details(raw));
  // A long step shows two lines; the chevron opens the rest.
  if (text.length > LONG && !className.includes("ask")) {
    li.classList.add("long");
    const more = document.createElement("button");
    more.type = "button";
    more.className = "more";
    more.setAttribute("aria-label", "Show all");
    more.setAttribute("aria-expanded", "false");
    more.addEventListener("click", () => {
      const open = li.classList.toggle("open");
      more.setAttribute("aria-expanded", String(open));
      more.setAttribute("aria-label", open ? "Show less" : "Show all");
    });
    li.append(more);
  }
  steps?.append(li);
  li.scrollIntoView({ block: "nearest" });
  return li;
}

const webHost = (url) => {
  try {
    const u = new URL(String(url));
    return /^https?:$/.test(u.protocol) ? u.hostname : "";
  } catch {
    return "";
  }
};
const bare = (host) => host.replace(/^www\./, "");
const SITES = { "space.foxmate": "Space", "www.googleapis.com": "Google" };

/** The site a card names: the host it acts on, or the host that open_site opens. */
export function siteOf(action) {
  if (action.tool === "open_site") return bare(webHost(action.args?.url) || "a new site");
  return SITES[action.domain] ?? bare(action.domain ?? "");
}

/** One short line: what happens on Approve. The form, the exact action and the JSON sit behind "Details". */
function lineOf(event) {
  const { action } = event;
  const args = action.args ?? {};
  if (action.tool === "open_site") return "Open this site in a new tab";
  if (action.tool === "pay") return event.detail || "Pay";
  if (action.tool === "click" && (event.detail ?? "").startsWith("The form holds")) {
    const label = args.target?.label?.trim();
    return label ? `Send the form with "${label.slice(0, 50)}"` : "Send the form";
  }
  return plain({ tool: action.tool, args });
}

/**
 * The site's icon: the tab's own favIconUrl when it is a data: address,
 * else a letter in a circle. The page never fetches an icon (UI4).
 */
export function siteIcon(site, favIconUrl) {
  const box = document.createElement("span");
  box.className = "site-icon";
  box.setAttribute("aria-hidden", "true");
  if (typeof favIconUrl === "string" && favIconUrl.startsWith("data:image/")) {
    const img = document.createElement("img");
    img.alt = "";
    img.src = favIconUrl;
    box.append(img);
    return box;
  }
  const letter = (site.match(/[a-z0-9]/i)?.[0] ?? "?").toUpperCase();
  let hue = 0;
  for (const c of site) hue = (hue * 31 + c.charCodeAt(0)) % 360;
  box.style.setProperty("--hue", String(hue));
  box.textContent = letter;
  return box;
}

/**
 * An approval card: the site's icon and name, one line of what happens, and
 * Deny, Always allow and Approve in a row. "Always allow" shows only when
 * the engine offers a rule (`event.ruleOffer`): never for pay, a fill, a
 * private run, a lent login or open_site (RU1-RU3, RU8, OS1, UI5). The form
 * detail and the exact action that foxgate allows sit behind "Details".
 * `onAnswer(answer)` gets "approve", "deny" or "always-allow". The
 * onboarding demo uses it too, with no port.
 */
export function approvalCard(event, { onAnswer, favIconUrl } = {}) {
  const li = document.createElement("li");
  li.className = "ask";
  li.dataset.requestId = event.requestId;
  const site = siteOf(event.action);
  const head = document.createElement("div");
  head.className = "ask-head";
  const label = document.createElement("span");
  label.className = "kind sr";
  label.textContent = "Needs your OK:";
  const name = document.createElement("strong");
  name.className = "site";
  name.textContent = site;
  head.append(siteIcon(site, favIconUrl), label, name);
  const pay = event.action.tool === "pay";
  const what = document.createElement("p");
  what.className = pay ? "text detail" : "text";
  what.textContent = lineOf(event);
  li.append(head, what);

  const box = document.createElement("details");
  box.className = "raw";
  const summary = document.createElement("summary");
  summary.textContent = "Details";
  box.append(summary);
  if (event.detail && !pay) {
    const detail = document.createElement("p");
    detail.className = "detail";
    detail.textContent = event.detail;
    box.append(detail);
  }
  const caption = document.createElement("p");
  caption.className = "caption";
  caption.textContent = "The exact action foxgate allows:";
  const pre = document.createElement("pre");
  pre.textContent = event.exactText ?? JSON.stringify(event.action, null, 2);
  box.append(caption, pre);
  li.append(box);

  const offer = event.ruleOffer;
  const row = document.createElement("div");
  row.className = "row";
  const choices = [["Deny", "deny"], ...(offer ? [["Always allow", "always-allow"]] : []), ["Approve", "approve"]];
  for (const [text, answer] of choices) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = text;
    button.dataset.answer = answer;
    button.className = answer === "approve" ? "primary" : answer === "deny" ? "ghost" : "";
    if (answer === "always-allow") button.title = `Always allow ${offer.tool} on ${offer.site}`;
    button.addEventListener("click", () => {
      onAnswer(answer);
      if (answer === "always-allow") {
        // The rule may fail; the buttons come back then (ruleFailed).
        for (const b of row.querySelectorAll("button")) b.disabled = true;
        li.dataset.answered = `Approved. foxmate now always allows ${offer.tool} on ${offer.site}.`;
        return;
      }
      settle(li, answer === "approve" ? "Approved." : "Denied.");
    });
    row.append(button);
  }
  li.append(row);
  return li;
}

/** An approval that was answered here, elsewhere, or that ended: no more buttons. */
export function settle(li, text) {
  const row = li.querySelector(".row");
  if (!row) return;
  const done = document.createElement("p");
  done.className = "answered";
  done.textContent = text;
  row.replaceWith(done);
  li.classList.add("settled");
}

// The tab the run works on, for the icon of its cards.
let runTab;

async function favIconFor(action) {
  if (!runTab || action.tool === "open_site") return undefined;
  const tab = await browser.tabs.get(runTab).catch(() => undefined);
  return tab && hostOf(tab) === action.domain ? tab.favIconUrl : undefined;
}

function approval(event) {
  const li = approvalCard(event, {
    onAnswer: (answer) => {
      if (answer === "always-allow") rules.approveAlways(port, event);
      else port.postMessage({ op: "answer", requestId: event.requestId, answer });
      state("working");
    },
  });
  steps?.append(li);
  li.scrollIntoView({ block: "nearest" });
  state("needs-approval");
  // The tab's own icon, when it has one in data: form; else the letter stays.
  void favIconFor(event.action).then((url) => {
    if (url?.startsWith("data:image/")) li.querySelector(".site-icon")?.replaceWith(siteIcon(siteOf(event.action), url));
  });
}

// A sign-in wait. With a saved login for the host, the user can ask for a fill; the fill waits for its own approval.
function handoff(event) {
  const li = line("Your turn", ` Sign in on this tab, then the agent goes on. ${event.message}`, "ask-note");
  if (event.fill) {
    const fill = document.createElement("button");
    fill.type = "button";
    fill.className = "small";
    fill.dataset.fill = "login";
    fill.textContent = "Fill saved login";
    fill.addEventListener("click", () => {
      fill.disabled = true;
      logins.fill(port);
    });
    const row = document.createElement("div");
    row.className = "fill";
    row.append(fill);
    li.append(row);
  }
  state("needs-approval", `Sign in on ${event.host}, then foxmate goes on.`);
}

const DECISION = { allow: "Allowed", deny: "Blocked", ask: "Asks you" };
const raw = (name, args) => `${name}(${typeof args === "string" ? args : JSON.stringify(args ?? {})})`;

function show(event) {
  if (event.type === "start") {
    line("Planner", ` ${event.planner}, ${event.planner === "foxbridge" ? "an outside agent over MCP" : "on this computer"}`, "meta");
    state("thinking");
  } else if (event.type === "recall" && (event.notes.length || event.error)) line("Memory", event.error ? ` not used: ${event.error}` : ` ${event.notes.join(" · ")}`, "meta");
  else if (event.type === "plan") {
    const words = event.calls.map((c) => plain({ tool: c.name, args: c.args })).join(", then ");
    line("Plan", ` ${words || event.text || "(no step)"}`, "plan", event.calls.map((c) => raw(c.name, c.args)).join("\n"));
    state("thinking");
  } else if (event.type === "decision") {
    // "Asks you" says what the card below says; the card is the one place to answer.
    if (event.decision === "ask") return;
    const what = event.action ? `: ${plain(event.action)}` : "";
    line(DECISION[event.decision] ?? event.decision, `${what}${event.reason ? ` (${event.reason})` : ""}`, event.decision === "deny" ? "bad" : "gate meta", `foxgate ${event.via}: ${event.decision}${event.reason ? `, ${event.reason}` : ""}${event.action ? `\n${JSON.stringify(event.action, null, 2)}` : ""}`);
    if (runState() !== "needs-approval") state("working");
  } else if (event.type === "approval-needed" || event.type === "login-approval") approval(event);
  else if (event.type === "tool-result") {
    line(event.ok ? "Result" : "Failed", ` ${event.summary}`, event.ok ? "ok" : "bad", `${event.name}${event.reason ? ` (${event.reason})` : ""}${event.detail ? `\n${event.detail}` : ""}`);
    state("working");
  } else if (event.type === "check") line(event.ok ? "Check passed" : "Check failed", ` ${event.checks.map((c) => `${c.ok ? "ok" : "not ok"} ${c.part}`).join("; ")}`, event.ok ? "ok" : "bad");
  else if (event.type === "refused") line("Refused", ` ${event.message}`, "bad");
  else if (event.type === "handoff") handoff(event);
  else if (event.type === "login-fill") line(event.status === "filled" ? "Filled" : "Not filled", event.status === "filled" ? ` the saved login on ${event.host}. Press the page's sign-in button.` : ` ${event.status}${event.reason ? ` (${event.reason})` : ""}.`, event.status === "filled" ? "ok" : "bad");
  else if (event.type === "handoff-end") {
    const ok = event.status === "signed-in";
    line(ok ? "Signed in" : "Sign-in ended", ok ? " The agent goes on." : ` ${event.status}. The agent stops.`, ok ? "ok" : "bad");
    state(ok ? "working" : "idle");
  } else if (event.type === "rule") line("Rule", ` ${event.tool ?? ""} on ${event.domain ?? ""}: ${event.note}`, event.decision === "deny" ? "bad" : "meta");
  else if (event.type === "opened") {
    runTab = event.tabId;
    runHost = event.host;
    line("Opened", ` ${event.host} in a new tab.`, "ok");
  } else if (event.type === "private") line("Private data", ` from ${event.source}. From now on foxmate asks you before it types or opens a page.`, "ask-note");
}

function newRun(goal) {
  const li = document.createElement("li");
  li.className = "run";
  const bubble = document.createElement("div");
  bubble.className = "goal";
  bubble.textContent = goal;
  steps = document.createElement("ol");
  steps.className = "steps";
  li.append(bubble, steps);
  $("conversation").append(li);
  $("empty").hidden = true;
  if ($("goal").value === goal) {
    $("goal").value = "";
    grow();
  }
  $("run").disabled = true;
  $("stop").disabled = false;
  state("thinking");
}

function end(result) {
  const text = { done: `Done: ${result.summary ?? ""}`, blocked: `Blocked (${result.reason}): ${result.message ?? ""}`, refused: `Refused (${result.reason}): ${result.message ?? ""}`, aborted: "Stopped.", restarted: "foxmate restarted. The task runs again from its goal." }[result.status] ?? result.status;
  const p = document.createElement("p");
  p.className = `end ${result.status === "done" ? "done" : "bad"}`;
  p.textContent = text;
  steps?.after(p);
  p.scrollIntoView({ block: "nearest" });
  $("run").disabled = false;
  $("stop").disabled = true;
  $("status").textContent = "";
  state(result.status === "done" ? "done" : "idle");
}

/** The goal box grows with its text, up to a limit. */
function grow() {
  const box = $("goal");
  box.style.height = "auto";
  box.style.height = `${Math.min(box.scrollHeight, 200)}px`;
}

export const chat = {
  init(p) {
    port = p;
    // The background page restarted: its waiting approvals and its run are gone. foxrunner runs the task again.
    port.onDisconnect.addListener(() => {
      for (const li of document.querySelectorAll("#conversation li.ask")) settle(li, "Ended: foxmate restarted.");
      if (steps && !steps.nextElementSibling) end({ status: "restarted" });
    });
    $("goal-form").addEventListener("submit", async (event) => {
      event.preventDefault();
      // With no web page open, the run asks before it opens a site (OS1-OS8).
      const tab = await targetTab();
      chat.start(tab?.id, $("goal").value);
    });
    const goal = $("goal");
    goal.addEventListener("input", grow);
    goal.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        if (goal.value.trim() && !$("run").disabled) $("goal-form").requestSubmit();
      }
    });
    $("suggestions").addEventListener("click", (event) => {
      const idea = event.target.closest("button")?.textContent;
      if (idea) chat.fill(idea);
    });
    $("stop").addEventListener("click", () => port.postMessage({ op: "stop" }));
  },
  /** Puts a goal in the box, for the user to check and run. */
  fill(text) {
    $("goal").value = text;
    grow();
    $("goal").focus();
  },
  start(tabId, goal, loanId) {
    $("goal").value = goal;
    runTab = tabId;
    runHost = "";
    if (tabId !== undefined) browser.tabs.get(tabId).then((tab) => { runHost = hostOf(tab); }, () => undefined);
    // Mail and calendar ask in the run, once each (G18): the composer has no switch for them.
    port.postMessage({ op: "run", ...(tabId === undefined ? {} : { tabId }), goal, ...(loanId ? { loanId } : {}) });
  },
  message(message) {
    if (message.run && shown.has(message.run.id)) {
      if (message.end && !steps?.nextElementSibling) end(message.end);
      return;
    }
    if (message.run) {
      shown.add(message.run.id);
      newRun(message.run.goal);
    }
    for (const event of message.events ?? []) show(event);
    if (message.event) show(message.event);
    if (message.end) end(message.end);
    if (message.error) $("status").textContent = message.error;
    if (message.ruleFailed) {
      const li = document.querySelector(`li.ask[data-request-id="${CSS.escape(message.ruleFailed)}"]`);
      if (li) delete li.dataset.answered;
      for (const b of li?.querySelectorAll(".row button") ?? []) b.disabled = false;
    }
    if (message.waiting) {
      // An approval that another channel answered, or that expired, loses its buttons.
      const open = new Set(message.waiting.map((w) => w.requestId));
      for (const li of document.querySelectorAll("#conversation li.ask[data-request-id]")) {
        if (!open.has(li.dataset.requestId)) settle(li, li.dataset.answered ?? "Answered.");
      }
    }
  },
};
