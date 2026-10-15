// `foxmate bench`: a foxbench adapter that drives foxmate in a real Firefox.
// For each task it opens the start page, runs the goal from the sidebar,
// and answers approvals with a policy that stands in for the human. A
// question of the planner goes to foxbench's stand-in user, Ask Sam (BN3).
import { tasks as benchTasks } from "foxbench";
import { BENCH_SCRIPTS } from "./bench-scripts.mjs";
import { runGoal, setSettings } from "./driver.mjs";
import { SESSION_MS, publicSite, reachModels } from "./remote.mjs";

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
 * when the chat does not answer (BN3). It posts as the task page would, with
 * the page as the Referer: a site behind a path mount (the tunnel a cloud
 * browser reaches it through) has no /user/ at the root of the address, and
 * the mount finds the site by the Referer (BN7).
 */
export async function askSam(url, question) {
  try {
    const res = await fetch(new URL("/user/", url), { method: "POST", headers: { referer: url }, body: new URLSearchParams({ q: question }), signal: AbortSignal.timeout(10_000) });
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

/**
 * The foxbench adapter. `planner` is foxmate's settings without the script.
 * `renew` starts a new session; when it is set (on Ichabod), the task sites
 * and model servers go through the tunnel, and a session older than
 * SESSION_MS is replaced before the next task.
 */
export function foxmateAdapter(session, { planner, approve = "careful", timeoutMs = 600_000, name, renew } = {}) {
  let tab;
  let models;
  let started = Date.now();
  /** Takes the model gate paths and the tunnel host out of a text. */
  const redact = (text) => (models ? models.redact(text) : String(text));
  return {
    name: name ?? `foxmate (${planner.planner === "scripted" ? "scripted planner" : `${planner.planner}${planner.model ? ` ${planner.model}` : ""}`}, ${approve} approvals)`,
    async runTask({ url, goal }) {
      const task = benchTasks.find((t) => t.goal === goal);
      if (renew && (Date.now() - started > SESSION_MS || !session.fox.browser.connected)) {
        await session.fox.close().catch(() => undefined);
        Object.assign(session, await renew());
        started = Date.now();
      }
      if (renew) models ??= await reachModels(planner);
      const base = models?.settings ?? planner;
      const settings = planner.planner === "scripted" ? { ...base, script: JSON.stringify(BENCH_SCRIPTS[task?.id] ?? []) } : base;
      const site = renew ? await publicSite(url) : undefined;
      // Each task closes only its own tab: a task that ends after its time limit must not close the next one's (BN5).
      const page = await session.fox.open(site?.url ?? url);
      tab = page;
      try {
        const run = await runGoal(session, { page, goal, settings, answer: policy(approve, goal), ask: (question) => askSam(url, question), onHandoff: (_text, at) => signInBySam(url, at), timeoutMs });
        const approvals = run.approvals.map((a) => `${a.answer}: ${a.detail || a.text}`.slice(0, 160));
        const questions = run.questions.map((q) => `asked: ${q.text} -> ${q.answer || "(skipped)"}`.slice(0, 200));
        const log = [run.status, ...questions, ...approvals].join("\n");
        // A benchmark that scores the answer reads the finish summary (BM6).
        const answer = run.done ? { answer: redact(run.status.replace(/^Done: /, "")) } : {};
        return { done: run.done, log: redact(log), metrics: runMetrics(run), ...answer };
      } finally {
        await page.close().catch(() => undefined);
        if (tab === page) tab = undefined;
        await site?.close();
      }
    },
    redact,
    async abort() {
      // A runtime port, not window.postMessage.
      // oxlint-disable-next-line unicorn/require-post-message-target-origin
      await session.sidebar.evaluate(() => window.foxmate.port.postMessage({ op: "stop" })).catch(() => undefined);
      await tab?.close().catch(() => undefined);
    },
    async close() {
      await setSettings(session.sidebar, {}).catch(() => undefined);
      await models?.close();
    },
  };
}
