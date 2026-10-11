// `foxmate bench`: a foxbench adapter that drives foxmate in a real Firefox.
// For each task it opens the start page, runs the goal from the sidebar,
// and answers approvals with a policy that stands in for the human. A
// question of the planner goes to foxbench's stand-in user, Ask Sam (BN3).
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

/**
 * Asks foxbench's stand-in user: posts the question to the Ask Sam chat at
 * /user/ on the task's site and returns Sam's newest answer, or undefined
 * when the chat does not answer (BN3).
 */
export async function askSam(url, question) {
  try {
    const res = await fetch(new URL("/user/", url), { method: "POST", body: new URLSearchParams({ q: question }), signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return undefined;
    const answers = [...(await res.text()).matchAll(/<strong>Sam:<\/strong> ([^<]*)<\/p>/g)];
    // foxbench writes each special character as a numeric entity.
    return answers.at(-1)?.[1].replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n))) || undefined;
  } catch {
    return undefined;
  }
}

/**
 * A sign-in wait in bench mode: Sam signs in for the agent through the Ask
 * Sam chat, as foxbench's stand-in user does, then the tab loads again so
 * foxpass sees the wall gone (BN4).
 */
export async function signInBySam(url, page) {
  await askSam(url, "I reached a sign-in page. Please sign in for me.");
  await page?.reload().catch(() => undefined);
}

/** foxbench metrics from one run: planner calls, tool results and approvals (BN2). */
export function runMetrics(run) {
  const count = (kind) => run.kinds.filter((k) => k === kind).length;
  // A replayed step of the workflow cache is a plan event with no model call (WF8).
  const replayed = (run.trail ?? []).filter((e) => e.kind === "run.route" && e.data?.by === "replay").length;
  return { modelCalls: count("loop.plan") - replayed, steps: count("loop.tool-result"), approvals: run.approvals.length };
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
        const run = await runGoal(session, { page: tab, goal, settings, answer: policy(approve, goal), ask: (question) => askSam(url, question), onHandoff: (_text, page) => signInBySam(url, page), timeoutMs });
        const approvals = run.approvals.map((a) => `${a.answer}: ${a.detail || a.text}`.slice(0, 160));
        const questions = run.questions.map((q) => `asked: ${q.text} -> ${q.answer || "(skipped)"}`.slice(0, 200));
        return { done: run.done, log: [run.status, ...questions, ...approvals].join("\n"), metrics: runMetrics(run) };
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
