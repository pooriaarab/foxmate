// HP1-HP8 (pass): a run meets a sign-in wall. The test acts as the user: it
// types the password and the code in the page after foxmate hands the step
// over. The planner is a stand-in llama-server that keeps every request, so
// the leak check reads exactly what the planner got.
import { readFileSync } from "node:fs";
import { poll } from "create-foxkit/e2e";
import { saveShot } from "../lib.mjs";
import { CODE, EMAIL, PASSWORD, startLogin } from "../login.mjs";
import { startPlanner } from "../planner.mjs";

const SECRETS = [PASSWORD, CODE];
const leaks = (value) => SECRETS.filter((s) => JSON.stringify(value).includes(s));
/** The "Your turn" line of a run in Chat, once it shows. */
const signInLine = (sidebar, runs) => poll(sidebar, (n) => [...(document.querySelectorAll("#conversation > li")[n]?.querySelectorAll(".steps li") ?? [])].find((li) => li.textContent.includes("Sign in on this tab"))?.textContent ?? null, runs, 60_000);

export default async function passCheck({ session, check, record, runGoal }) {
  const { fox, sidebar } = session;
  const [planner, site] = await Promise.all([startPlanner(), startLogin()]);
  const settings = { planner: "llama-server", baseURL: planner.url, model: "fake" };
  try {
    planner.play([{ tool: "snapshot" }, { tool: "finish", args: { summary: "The balance is $1,204.50." } }]);
    const page = await fox.open(`${site.url}/account`);
    const runs = await sidebar.evaluate(() => document.querySelectorAll("#conversation > li").length);
    // The user: wait for foxmate to hand the step over, then sign in in the page.
    const user = (async () => {
      const line = await signInLine(sidebar, runs);
      await saveShot(sidebar, "chat-sign-in");
      const banner = await poll(page, () => document.getElementById("foxpass-banner")?.shadowRoot?.textContent ?? null);
      await page.type("#email", EMAIL);
      await page.type("#password", PASSWORD);
      await Promise.all([page.waitForNavigation().catch(() => undefined), page.click("button[type=submit]")]);
      await poll(page, () => location.pathname === "/verify" && Boolean(document.getElementById("code")));
      await page.type("#code", CODE);
      await page.click("button[type=submit]");
      return { line, banner };
    })();
    // A failed step of the user shows when the check awaits it, not as a crash.
    user.catch(() => undefined);
    const run = await runGoal(session, { page, goal: "Read my balance on my bank.", settings, shot: "chat-signed-in" });
    const seen = await user;
    const ended = run.trail.find((e) => e.kind === "handoff.ended")?.data;
    record.runs.pass = { status: run.status, steps: run.steps, kinds: run.kinds, requests: planner.bodies.length };
    check("HP1 the run waits at the wall, and the planner reads the page after the sign-in", { paused: true, read: true, wall: false },
      { paused: run.kinds.includes("handoff.paused"), read: planner.bodies[1]?.includes("Balance: $1,204.50") ?? false, wall: planner.bodies.some((b) => b.includes("Sign in to your bank")) });
    check("HP2 Chat tells the user what to do", true, seen.line.startsWith("Your turn Sign in on this tab, then the agent goes on."));
    check("HP2 foxpass shows its banner in the page", true, /password/i.test(seen.banner));
    check("HP3 the password page, then the code page, is one wait that ends signed in", { pauses: 1, status: "signed-in" },
      { pauses: run.kinds.filter((k) => k === "handoff.paused").length, status: ended?.status });
    check("HP3 the run goes on and finishes", true, run.done && run.trailOk);

    // HP5, HP6: the typed password and code are nowhere the planner, the log, the sidebar or memory can see.
    const everything = await sidebar.evaluate(async () => ({
      trail: (await browser.runtime.sendMessage({ op: "trail" })).entries,
      memory: await browser.runtime.sendMessage({ op: "memory-list" }),
      storage: await browser.storage.local.get(null),
      sidebar: document.body.innerText,
    }));
    check("HP5 the planner's requests hold no typed password or code", [], leaks(planner.bodies));
    check("HP6 the log, memory, storage and the sidebar hold no typed password or code", { trail: [], memory: [], storage: [], sidebar: [] },
      Object.fromEntries(Object.entries(everything).map(([k, v]) => [k, leaks(v)])));
    check("HP6 the handoff entries in the log hold the kind, the host and the status only", [["host", "kinds"], ["status"]],
      run.trail.filter((e) => e.kind.startsWith("handoff.")).map((e) => Object.keys(e.data).toSorted()));

    // HP4: the user presses Stop while the run waits.
    await page.goto(`${site.url}/logout`);
    planner.play([{ tool: "snapshot" }]);
    const again = sidebar.evaluate(() => document.querySelectorAll("#conversation > li").length).then((n) => signInLine(sidebar, n).then(() => sidebar.evaluate(() => document.getElementById("stop").click())));
    const stopped = await runGoal(session, { page, goal: "Read my balance on my bank.", settings });
    await again;
    check("HP4 Stop ends the wait and the run", { status: "Stopped.", ended: "cancelled", requests: 1 },
      { status: stopped.status, ended: stopped.trail.find((e) => e.kind === "handoff.ended")?.data.status, requests: planner.bodies.length });

    const manifest = JSON.parse(readFileSync("dist-ext/manifest.json", "utf8"));
    check("HP8 the manifest asks for no webNavigation permission", false, [...manifest.permissions, ...(manifest.optional_permissions ?? [])].includes("webNavigation"));
    await page.close();
  } finally {
    await Promise.all([planner.close(), site.close()]);
  }
}
