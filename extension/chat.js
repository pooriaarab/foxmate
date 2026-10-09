// The Chat view: a goal box, and each run as a conversation. A run shows
// the planner's steps, each tool call and gate decision, inline approvals
// with the exact action, the results and the final check.
const $ = (id) => document.getElementById(id);
let port;
let steps;

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
  for (const [label, answer] of [["Approve", "approve"], ["Deny", "deny"]]) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = label;
    button.dataset.answer = answer;
    button.addEventListener("click", () => {
      port.postMessage({ op: "answer", requestId: event.requestId, answer });
      row.replaceWith(document.createTextNode(answer === "approve" ? "Approved." : "Denied."));
    });
    row.append(button);
  }
  li.append(...(event.detail ? [detail] : []), pre, row);
}

function show(event) {
  if (event.type === "start") line("Planner", ` ${event.planner} (${event.privacy === "cloud" ? "own key, cloud" : "private, on this computer"})`);
  else if (event.type === "recall" && (event.notes.length || event.error)) line("Memory", event.error ? ` not used: ${event.error}` : ` ${event.notes.join(" · ")}`);
  else if (event.type === "plan") line("Plan", ` ${event.calls.map((c) => `${c.name}(${c.args})`).join(", ") || event.text || "(no call)"}`);
  else if (event.type === "decision") line("Gate", ` ${event.via} ${event.decision}${event.reason ? `: ${event.reason}` : ""}`, event.decision === "deny" ? "bad" : "");
  else if (event.type === "approval-needed") approval(event);
  else if (event.type === "tool-result") line(event.ok ? "Result" : "Failed", ` ${event.name}: ${event.summary}${event.detail ? ` (${event.detail})` : ""}`, event.ok ? "ok" : "bad");
  else if (event.type === "check") line(event.ok ? "Check passed" : "Check failed", ` ${event.checks.map((c) => `${c.ok ? "ok" : "not ok"} ${c.part}`).join("; ")}`, event.ok ? "ok" : "bad");
  else if (event.type === "refused") line("Refused", ` ${event.message}`, "bad");
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
  const text = { done: `Done: ${result.summary ?? ""}`, blocked: `Blocked (${result.reason}): ${result.message ?? ""}`, refused: `Refused (${result.reason}): ${result.message ?? ""}`, aborted: "Stopped." }[result.status] ?? result.status;
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
    $("goal-form").addEventListener("submit", async (event) => {
      event.preventDefault();
      const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
      if (tab?.id !== undefined) chat.start(tab.id, $("goal").value);
    });
    $("stop").addEventListener("click", () => port.postMessage({ op: "stop" }));
  },
  start(tabId, goal, loanId) {
    $("goal").value = goal;
    port.postMessage({ op: "run", tabId, goal, ...(loanId ? { loanId } : {}) });
  },
  message(message) {
    if (message.run) newRun(message.run.goal);
    for (const event of message.events ?? []) show(event);
    if (message.event) show(message.event);
    if (message.end) end(message.end);
    if (message.error) $("status").textContent = message.error;
    if (message.waiting) {
      // An approval that another channel answered, or that expired, loses its buttons.
      const open = new Set(message.waiting.map((w) => w.requestId));
      for (const li of document.querySelectorAll("li.ask[data-request-id]")) {
        const row = li.querySelector(".row");
        if (row && !open.has(li.dataset.requestId)) row.replaceWith(document.createTextNode("Answered."));
      }
    }
  },
};
