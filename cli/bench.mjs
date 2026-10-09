// `foxmate bench`: a foxbench adapter that drives foxmate in a real Firefox.
// For each task it opens the start page, runs the goal from the sidebar,
// and answers approvals with a policy that stands in for the human.
import { tasks as benchTasks } from "foxbench";
import { BENCH_SCRIPTS } from "./bench-scripts.mjs";
import { runGoal, setSettings } from "./driver.mjs";

const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;

/**
 * How the stand-in human answers. "all" approves everything. "careful"
 * reads each approval and denies one that sends to an email address that
 * is not for someone the goal names ("Reply to Dana Lee" allows
 * dana.lee@...). "none" denies everything.
 */
export function policy(name, goal) {
  if (name === "all") return () => "approve";
  if (name === "none") return () => "deny";
  const words = new Set(goal.toLowerCase().match(/[a-z]+/g));
  const named = (email) => goal.toLowerCase().includes(email.toLowerCase()) || email.toLowerCase().split("@")[0].split(/[._-]/).every((part) => words.has(part));
  return (ask) => ((`${ask.detail} ${ask.text}`.match(EMAIL) ?? []).every(named) ? "approve" : "deny");
}

/** The foxbench adapter. `planner` is foxmate's settings without the script. */
export function foxmateAdapter(session, { planner, approve = "careful", timeoutMs = 600_000, name } = {}) {
  let tab;
  return {
    name: name ?? `foxmate (${planner.planner === "scripted" ? "scripted planner" : `${planner.planner}${planner.model ? ` ${planner.model}` : ""}`}, ${approve} approvals)`,
    async runTask({ url, goal }) {
      const task = benchTasks.find((t) => t.goal === goal);
      const settings = planner.planner === "scripted" ? { ...planner, script: JSON.stringify(BENCH_SCRIPTS[task?.id] ?? []) } : planner;
      tab = await session.fox.open(url);
      try {
        const run = await runGoal(session, { page: tab, goal, settings, answer: policy(approve, goal), timeoutMs });
        const approvals = run.approvals.map((a) => `${a.answer}: ${a.detail || a.text}`.slice(0, 160));
        return { done: run.done, log: [run.status, ...approvals].join("\n") };
      } finally {
        await tab.close().catch(() => undefined);
      }
    },
    async abort() {
      // A runtime port, not window.postMessage.
      // oxlint-disable-next-line unicorn/require-post-message-target-origin
      await session.sidebar.evaluate(() => window.foxmate.port.postMessage({ op: "stop" })).catch(() => undefined);
      await tab?.close().catch(() => undefined);
    },
    async close() {
      await setSettings(session.sidebar, {}).catch(() => undefined);
    },
  };
}
