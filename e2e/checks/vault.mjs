// LV1, LV4-LV6, LV11-LV13 (vault): the user saves a login in Settings. A run
// meets the local bank's sign-in wall, the user clicks "Fill saved login" and
// approves foxgate's exact fill, then signs in. The planner is a stand-in
// llama-server that keeps every request, so the leak check reads exactly
// what the planner got.
import { readFileSync } from "node:fs";
import { poll } from "create-foxkit/e2e";
import { saveShot } from "../lib.mjs";
import { CODE, EMAIL, PASSWORD, startLogin } from "../login.mjs";
import { startPlanner } from "../planner.mjs";

const leaks = (value) => JSON.stringify(value).includes(PASSWORD);

export default async function vaultCheck({ session, check, record, runGoal }) {
  const { fox, sidebar } = session;
  const [planner, site] = await Promise.all([startPlanner(), startLogin()]);
  const host = new URL(site.url).hostname;
  const settings = { planner: "llama-server", baseURL: planner.url, model: "fake" };
  try {
    // LV12: save the login through the Settings view, as a person would.
    const saved = await sidebar.evaluate(async (h, user, pass) => {
      window.foxmate.show("settings");
      document.getElementById("login-site").value = h;
      document.getElementById("login-user").value = user;
      document.getElementById("login-pass").value = pass;
      document.getElementById("login-save").click();
      for (let i = 0; i < 100 && !document.getElementById("login-status").textContent.startsWith("Saved"); i++) await new Promise((r) => setTimeout(r, 100));
      return { status: document.getElementById("login-status").textContent, field: document.getElementById("login-pass").value, list: document.getElementById("login-list").textContent };
    }, host, EMAIL, PASSWORD);
    await saveShot(sidebar, "settings-saved-login");
    check("LV12 Settings saves the login, clears the field and lists no password", { status: `Saved. The password for ${host} is in foxvault.`, field: "", list: `${host}${EMAIL} · password savedRemove` }, saved);
    const stored = await sidebar.evaluate(async () => ({ storage: await browser.storage.local.get(null), sidebar: document.body.innerText }));
    check("LV12 storage.local and the sidebar hold no password in clear", { storage: false, sidebar: false }, { storage: leaks(stored.storage), sidebar: leaks(stored.sidebar) });
    await sidebar.evaluate(() => window.foxmate.show("chat"));

    planner.play([{ tool: "snapshot" }, { tool: "finish", args: { summary: "The balance is $1,204.50." } }]);
    const page = await fox.open(`${site.url}/account`);
    const runs = await sidebar.evaluate(() => document.querySelectorAll("#conversation > li").length);
    // The user: at the wait, click "Fill saved login". runGoal approves the fill. Then sign in.
    const user = (async () => {
      const offered = await poll(sidebar, (n) => {
        const button = document.querySelectorAll("#conversation > li")[n]?.querySelector('.steps li button[data-fill="login"]');
        if (!button) return null;
        button.click();
        return button.textContent;
      }, runs, 60_000);
      const filled = await poll(page, (email) => {
        const password = document.getElementById("password")?.value ?? "";
        return password && document.getElementById("email")?.value === email ? { username: true, password: password.length } : null;
      }, EMAIL, 60_000);
      await saveShot(sidebar, "chat-fill-approved");
      await Promise.all([page.waitForNavigation().catch(() => undefined), page.click("button[type=submit]")]);
      await poll(page, () => location.pathname === "/verify" && Boolean(document.getElementById("code")));
      await page.type("#code", CODE);
      await page.click("button[type=submit]");
      return { offered, filled };
    })();
    user.catch(() => undefined);
    const asks = [];
    const run = await runGoal(session, { page, goal: "Read my balance on my bank.", settings, answer: (ask) => { asks.push(ask); return "approve"; } });
    const seen = await user;
    record.runs.vault = { status: run.status, steps: run.steps, kinds: run.kinds, requests: planner.bodies.length };

    const exact = asks[0] ? JSON.parse(asks[0].text) : {};
    check("LV4 one approval, for the fill, before anything is filled", { asks: 1, offered: "Fill saved login" }, { asks: asks.length, offered: seen.offered });
    check("LV5 the approval is foxgate's exact fill on the bank's host and its password field", { tool: "foxvault.fill", scope: "fill", domain: host, selector: "#password", handle: true },
      { tool: exact.tool, scope: exact.scope, domain: exact.domain, selector: exact.args?.selector, handle: /^vault:login-[0-9a-f]{8}$/.test(exact.args?.handle ?? "") });
    check("LV5 the approval detail names the host and both fields", true, [host, "Password (#password)", "Email (#email)"].every((t) => asks[0]?.detail.includes(t)));
    check("LV11 the page gets the password and the username", { username: true, password: PASSWORD.length }, seen.filled);
    check("LV1 the run waits, the user signs in with the fill, and the run finishes", { done: true, trail: true, fill: "filled", read: true },
      { done: run.done, trail: run.trailOk, fill: run.trail.find((e) => e.kind === "login.fill")?.data.status, read: planner.bodies.at(-1)?.includes("Balance: $1,204.50") ?? false });

    // LV1, LV6: the password is in no planner request, no log entry and not in the export.
    const everything = await sidebar.evaluate(async () => ({
      trail: (await browser.runtime.sendMessage({ op: "trail" })).entries,
      export: (await browser.runtime.sendMessage({ op: "trail-export" })).jsonl,
      storage: await browser.storage.local.get(null),
      sidebar: document.body.innerText,
    }));
    check("LV1 the planner's requests hold no saved password", false, leaks(planner.bodies));
    check("LV6 the log, its export, storage and the sidebar hold no saved password", { trail: false, export: false, storage: false, sidebar: false },
      Object.fromEntries(Object.entries(everything).map(([k, v]) => [k, leaks(v)])));
    // The export holds the fill's entries, so a missing password is not a missing record.
    check("LV6 the export holds the release and the fill, by handle", true, Boolean(exact.args?.handle) && everything.export.includes(`"vault.release"`) && everything.export.includes(exact.args.handle));
    const release = run.trail.find((e) => e.kind === "vault.release")?.data;
    check("LV6 the log records the release by handle and host only", { keys: ["handle", "host", "kind"], host, handle: exact.args?.handle }, release && { keys: Object.keys(release).toSorted(), host: release.host, handle: release.handle });

    const manifest = JSON.parse(readFileSync("dist-ext/manifest.json", "utf8"));
    check("LV13 the manifest still asks for no webNavigation permission", false, [...manifest.permissions, ...(manifest.optional_permissions ?? [])].includes("webNavigation"));
    await sidebar.evaluate((h) => browser.runtime.sendMessage({ op: "login-remove", host: h }), host);
    await page.close();
  } finally {
    await Promise.all([planner.close(), site.close()]);
  }
}
