// Chat: the one conversation. Each run is a goal bubble and a list of
// compact steps: the planner, each plan, gate decision and result, inline
// approvals, sign-in waits, and the end. Each step says what happens in
// plain words; the raw tool call sits behind "Details". The dock shows the
// run state. The E2E driver reads this DOM: #conversation > li, .goal,
// .steps li (the label first), li.ask with pre, .detail and
// .row button[data-answer], and .end.
import { logins, rules } from "./engine.js";
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

// The run state: idle, thinking, working, needs-approval or done.
let current = "idle";
const runState = () => current;

function state(next, text) {
  current = next;
  $("presence").dataset.state = next;
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

function approval(event) {
  const li = line("Approve?", ` ${event.action.tool} on ${event.action.domain}`, "ask");
  li.dataset.requestId = event.requestId;
  const detail = document.createElement("p");
  detail.className = "detail";
  detail.textContent = event.detail ?? "";
  const pre = document.createElement("pre");
  pre.textContent = event.exactText ?? JSON.stringify(event.action, null, 1);
  const row = document.createElement("div");
  row.className = "row";
  // "Always allow" shows only when foxmate offers a rule: never for pay, a fill, a private run or a lent login (RU1-RU3, RU8).
  const offer = event.ruleOffer;
  const choices = [["Approve", "approve"], ["Deny", "deny"], ...(offer ? [[`Always allow ${offer.tool} on ${offer.site}`, "always-allow"]] : [])];
  for (const [label, answer] of choices) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = label;
    button.dataset.answer = answer;
    button.addEventListener("click", () => {
      if (answer === "always-allow") rules.approveAlways(port, event);
      else port.postMessage({ op: "answer", requestId: event.requestId, answer });
      if (answer === "always-allow") {
        // The rule may fail; the buttons come back then (ruleFailed).
        for (const b of row.querySelectorAll("button")) b.disabled = true;
        li.dataset.answered = `Approved, and always allowed ${offer.tool} on ${offer.site}.`;
        return;
      }
      row.replaceWith(document.createTextNode(answer === "approve" ? "Approved." : "Denied."));
    });
    row.append(button);
  }
  li.append(...(event.detail ? [detail] : []), pre, row);
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
