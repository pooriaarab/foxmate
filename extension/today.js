// The Today view: the goal tasks (running, waiting for you, finished), and
// the schedules that start new ones.
const $ = (id) => document.getElementById(id);
const send = async (message) => {
  const answer = await browser.runtime.sendMessage(message);
  if (answer?.error) throw new Error(answer.error);
  return answer;
};

function item(text, meta, buttons = []) {
  const li = document.createElement("li");
  const p = document.createElement("p");
  p.className = "text";
  p.textContent = text;
  const m = document.createElement("div");
  m.className = "muted";
  m.textContent = meta;
  li.append(p, m);
  if (buttons.length) {
    const row = document.createElement("div");
    row.className = "row";
    for (const [label, onClick] of buttons) {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = label;
      b.addEventListener("click", onClick);
      row.append(b);
    }
    li.append(row);
  }
  return li;
}

/** What the task did, in plain words. */
function state(task, waiting) {
  const end = task.steps[0]?.output;
  if (task.status === "running") return waiting ? "waiting for you" : "running";
  if (task.status === "done") return end?.status === "done" ? `done: ${end.summary ?? ""}` : `${end?.status ?? "ended"}: ${end?.message ?? end?.reason ?? ""}`;
  return task.error ? `${task.status}: ${task.error}` : task.status;
}

async function load() {
  const { tasks, schedules, waiting } = await send({ op: "tasks" });
  $("waiting").hidden = !waiting;
  $("waiting").textContent = waiting ? `${waiting} approval${waiting > 1 ? "s" : ""} wait for you in Chat.` : "";
  $("tasks").replaceChildren(...tasks.map((task) => {
    const li = item(task.input.goal, `${state(task, waiting)} · ${new Date(task.createdAt).toLocaleTimeString()}${task.scheduleId ? " · from a schedule" : ""}${task.steps[0]?.attempt > 1 ? ` · attempt ${task.steps[0].attempt}` : ""}`,
      task.status === "running" || task.status === "queued" ? [["Cancel", () => send({ op: "cancel-task", id: task.id }).then(load)]] : []);
    li.dataset.status = task.status;
    return li;
  }));
  $("schedules").replaceChildren(...schedules.map((s) => item(s.input.goal, `${s.cron} · next ${new Date(s.nextRunAt).toLocaleString()} · ${s.input.url}`, [["Remove", () => send({ op: "unschedule", id: s.id }).then(load)]])));
}

export const today = {
  init() {
    $("schedule-when").addEventListener("change", () => {
      $("schedule-time").hidden = $("schedule-when").value !== "daily";
    });
    $("schedule-form").addEventListener("submit", async (event) => {
      event.preventDefault();
      const [hour, minute] = $("schedule-time").value.split(":").map(Number);
      const cron = $("schedule-when").value === "daily" ? `${minute} ${hour} * * *` : $("schedule-when").value;
      try {
        await send({ op: "schedule", goal: $("schedule-goal").value, url: $("schedule-url").value, cron });
        $("schedule-status").textContent = "Added.";
        await load();
      } catch (error) {
        $("schedule-status").textContent = `Not added: ${error.message}`;
      }
    });
  },
  shown: load,
  message(message) {
    if ((message.end || message.waiting || message.run) && !$("tasks").closest("section").hidden) load();
  },
};
