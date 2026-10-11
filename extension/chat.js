// The Chat view: a goal box, and each run as a conversation. A run shows
// the planner's steps, each tool call and gate decision, inline approvals
// with the exact action, the results and the final check.
const $ = (id) => document.getElementById(id);
let port;
let steps;
// A port that connects again gets the current run once more; show it once.
const shown = new Set();

function line(kind, text, className = "") {
  const li = document.createElement("li");
  li.className = className;
  const label = document.createElement("span");
  label.className = "kind";
  label.textContent = kind;
  li.append(label, document.createTextNode(text));
  steps?.append(li);
  li.scrollIntoView({ block: "nearest" });
  return li;
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
      port.postMessage({ op: "answer", requestId: event.requestId, answer });
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

// A sign-in wait. With a saved login for the host, the user can ask for a fill; it waits for Approve.
function handoff(event) {
  const li = line("Your turn", ` Sign in on this tab, then the agent goes on. ${event.message}`, "ask-note");
  if (!event.fill) return;
  const row = document.createElement("div");
  row.className = "row";
  const button = document.createElement("button");
  button.type = "button";
  button.dataset.fill = "login";
  button.textContent = "Fill saved login";
  button.addEventListener("click", () => {
    button.disabled = true;
    port.postMessage({ op: "fill-login" });
  });
  row.append(button);
  li.append(row);
}

function show(event) {
  if (event.type === "start") line("Planner", ` ${event.planner} (${event.planner === "foxbridge" ? "an outside agent over MCP" : "on this computer"})`);
  else if (event.type === "recall" && (event.notes.length || event.error)) line("Memory", event.error ? ` not used: ${event.error}` : ` ${event.notes.join(" · ")}`);
  else if (event.type === "plan") line("Plan", ` ${event.calls.map((c) => `${c.name}(${c.args})`).join(", ") || event.text || "(no call)"}`);
  else if (event.type === "decision") line("Gate", ` ${event.via} ${event.decision}${event.reason ? `: ${event.reason}` : ""}`, event.decision === "deny" ? "bad" : "");
  else if (event.type === "approval-needed") approval(event);
  else if (event.type === "tool-result") line(event.ok ? "Result" : "Failed", ` ${event.name}: ${event.summary}${event.detail ? ` (${event.detail})` : ""}`, event.ok ? "ok" : "bad");
  else if (event.type === "check") line(event.ok ? "Check passed" : "Check failed", ` ${event.checks.map((c) => `${c.ok ? "ok" : "not ok"} ${c.part}`).join("; ")}`, event.ok ? "ok" : "bad");
  else if (event.type === "refused") line("Refused", ` ${event.message}`, "bad");
  else if (event.type === "handoff") handoff(event);
  else if (event.type === "login-approval") approval(event);
  else if (event.type === "login-fill") line(event.status === "filled" ? "Filled" : "Not filled", event.status === "filled" ? ` the saved login on ${event.host}. Press the page's sign-in button.` : ` ${event.status}${event.reason ? ` (${event.reason})` : ""}.`, event.status === "filled" ? "ok" : "bad");
  else if (event.type === "handoff-end") line(event.status === "signed-in" ? "Signed in" : "Sign-in ended", event.status === "signed-in" ? " The agent goes on." : ` ${event.status}. The agent stops.`, event.status === "signed-in" ? "ok" : "bad");
  else if (event.type === "rule") line("Rule", ` ${event.tool ?? ""} on ${event.domain ?? ""}: ${event.note}`, event.decision === "deny" ? "bad" : "");
  else if (event.type === "private") line("Private data", ` from ${event.source}. From now on foxmate asks you before it types or opens a page.`, "ask-note");
}

function newRun(goal) {
  const li = document.createElement("li");
  const bubble = document.createElement("div");
  bubble.className = "goal";
  bubble.textContent = goal;
  steps = document.createElement("ol");
  steps.className = "steps";
  li.append(bubble, steps);
  $("conversation").append(li);
  $("run").disabled = true;
  $("stop").disabled = false;
  $("status").textContent = "Running…";
}

function end(result) {
  const text = { done: `Done: ${result.summary ?? ""}`, blocked: `Blocked (${result.reason}): ${result.message ?? ""}`, refused: `Refused (${result.reason}): ${result.message ?? ""}`, aborted: "Stopped.", restarted: "foxmate restarted. The task runs again from its goal." }[result.status] ?? result.status;
  const p = document.createElement("p");
  p.className = `end ${result.status === "done" ? "done" : "bad"}`;
  p.textContent = text;
  steps?.after(p);
  $("run").disabled = false;
  $("stop").disabled = true;
  $("status").textContent = "";
}

export const chat = {
  init(p) {
    port = p;
    // The background page restarted: its waiting approvals and its run are gone. foxrunner runs the task again.
    port.onDisconnect.addListener(() => {
      for (const row of document.querySelectorAll("li.ask .row")) row.replaceWith(document.createTextNode("Ended: foxmate restarted."));
      if (steps && !steps.nextElementSibling) end({ status: "restarted" });
    });
    $("goal-form").addEventListener("submit", async (event) => {
      event.preventDefault();
      const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
      if (tab?.id !== undefined) chat.start(tab.id, $("goal").value);
    });
    $("stop").addEventListener("click", () => port.postMessage({ op: "stop" }));
  },
  start(tabId, goal, loanId) {
    $("goal").value = goal;
    // Mail and calendar ask in the run, once each (G18): there is no switch for them.
    port.postMessage({ op: "run", tabId, goal, ...(loanId ? { loanId } : {}) });
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
      for (const li of document.querySelectorAll("li.ask[data-request-id]")) {
        const row = li.querySelector(".row");
        if (row && !open.has(li.dataset.requestId)) row.replaceWith(document.createTextNode(li.dataset.answered ?? "Answered."));
      }
    }
  },
};
