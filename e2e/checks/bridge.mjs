// BR1-BR8 (bridge): a real MCP client on foxbridge's own MCP server and
// host, as Claude Code runs them. The test plays the user in the sidebar:
// it shares one tab, answers the approvals in Chat, and uses Stop.
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { poll, serve } from "create-foxkit/e2e";
import { install, manifestDir } from "foxbridge";
import { saveShot } from "../lib.mjs";

// The host reads FOXBRIDGE_SOCKET from Firefox's environment, so it is set
// when run.mjs imports this file, before Firefox starts.
const work = mkdtempSync(join(tmpdir(), "fmt-bridge-"));
process.env.FOXBRIDGE_SOCKET = join(work, "host.sock");
const NEEDED = { permissions: ["nativeMessaging"], data_collection: ["websiteContent"] };

/**
 * BR11: the test says yes for the user. BiDi cannot click in a moz-extension:
 * page, so it writes the grant to Firefox's own permission store from the
 * browser window, as the prompt does. dist-ext/ has no grant hook.
 */
async function grant(fox) {
  const tree = await fox.browser.connection.send("browsingContext.getTree", { "moz:scope": "chrome" });
  await fox.browser.connection.send("script.evaluate", {
    expression: `(async () => {
      const { ExtensionPermissions } = ChromeUtils.importESModule("resource://gre/modules/ExtensionPermissions.sys.mjs");
      await ExtensionPermissions.add("${fox.extensionId}", { permissions: ${JSON.stringify(NEEDED.permissions)}, origins: [], data_collection: ${JSON.stringify(NEEDED.data_collection)} }, WebExtensionPolicy.getByID("${fox.extensionId}").extension);
    })()`,
    target: { context: tree.result.contexts[0].context }, awaitPromise: true, "moz:scope": "chrome",
  });
}
const CLI = join(dirname(createRequire(import.meta.url).resolve("foxbridge")), "cli.js");

/** The answer to the next approval in Chat. */
async function answer(sidebar, choice, shot) {
  const ask = await poll(sidebar, () => {
    const li = [...document.querySelectorAll("li.ask")].findLast((l) => l.querySelector(".row button"));
    return li && { id: li.dataset.requestId, text: li.querySelector("pre").textContent, detail: li.querySelector(".detail")?.textContent ?? "" };
  }, undefined, 30_000);
  if (shot) await saveShot(sidebar, shot);
  await sidebar.evaluate((id, a) => document.querySelector(`li.ask[data-request-id="${id}"] button[data-answer="${a}"]`).click(), ask.id, choice);
  return ask;
}

export default async function bridgeCheck({ session, check, record }) {
  const { fox, sidebar } = session;
  // The test installs the real host manifest for foxmate, and puts back what was there.
  const files = [join(manifestDir(), "foxbridge.json"), join(homedir(), ".foxbridge", "foxbridge-host"), join(homedir(), ".foxbridge", "secret")];
  const saved = files.map((file, i) => existsSync(file) && (copyFileSync(file, join(work, `saved-${i}`)), true));
  const fresh = [manifestDir(), join(homedir(), ".foxbridge")].filter((dir) => !existsSync(dir));
  const site = await serve("e2e/site");
  const client = new Client({ name: "foxmate-e2e", version: "1.0.0" });
  try {
    await install({ extensionId: "foxmate@pooriaarab" });
    const page = await fox.open(`${site.url}/bridge.html`);
    await fox.open(`${site.url}/table.html`);
    const [shared, other] = await sidebar.evaluate(async (u) => [await window.foxmate.tabFor(`${u}/bridge.html`), await window.foxmate.tabFor(`${u}/table.html`)], site.url);
    const status = (text) => poll(sidebar, (t) => (document.getElementById("bridge-status").textContent.includes(t) ? document.getElementById("bridge-status").textContent : null), text, 20_000);
    const manifest = JSON.parse(readFileSync("dist-ext/manifest.json", "utf8"));
    check("BR10 nativeMessaging and websiteContent are optional, so an update asks nothing", { required: false, optional: true, data: true },
      { required: manifest.permissions.includes("nativeMessaging"), optional: manifest.optional_permissions?.includes("nativeMessaging"), data: manifest.browser_specific_settings.gecko.data_collection_permissions.optional.includes("websiteContent") });
    // BR9: with no consent, sharing keeps the bridge off.
    await sidebar.evaluate((id) => window.foxmate.share(id), shared);
    check("BR9 without Firefox's consent, the bridge stays off", "Firefox did not allow it, so the bridge stays off.", await status("did not allow"));
    // A message that skips the sidebar's check meets the background page's check.
    await sidebar.evaluate((id) => {
      document.getElementById("bridge-status").textContent = "";
      // A runtime port takes no target origin.
      // oxlint-disable-next-line unicorn/require-post-message-target-origin
      window.foxmate.port.postMessage({ op: "bridge-share", tabId: id });
    }, shared);
    check("BR9 the background page refuses a share without the consent too", "Firefox did not allow it, so the bridge stays off.", await status("did not allow"));
    await grant(fox);
    check("BR11 dist-ext/ has no hook that grants the consent", false, readFileSync("dist-ext/sidebar.js", "utf8").includes("ExtensionPermissions") || readFileSync("dist-ext/background.js", "utf8").includes("ExtensionPermissions"));
    check("BR9 after Firefox's yes, the extension holds the consent and the permission", true, await sidebar.evaluate((n) => browser.permissions.contains(n), NEEDED));
    await sidebar.evaluate((id) => window.foxmate.share(id), shared);
    await status("Waiting for Claude Code");
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [CLI, "mcp"], env: { ...process.env }, stderr: "ignore" }));
    const call = async (name, args = {}) => {
      const r = await client.callTool({ name, arguments: args });
      record.runs[`bridge-${name}`] = { isError: r.isError === true, text: r.content.map((c) => c.text).join("\n").slice(0, 400) };
      return { isError: r.isError === true, text: r.content.map((c) => c.text).join("\n") };
    };
    const listed = await call("list_tabs");
    check("BR1 list_tabs names the one shared tab", { error: false, tab: true, connected: true },
      { error: listed.isError, tab: listed.text.includes(`tab ${shared} on 127.0.0.1`), connected: (await status("connected")).startsWith("Claude Code is connected") });
    const snap = await call("snapshot", { tabId: shared });
    const save = snap.text.match(/\[([^\]]+)\] button "Subscribe/)?.[1];
    check("BR2 BR4 a page read needs no approval, and foxshield removed the hidden text", { error: false, control: true, hidden: false },
      { error: snap.isError, control: Boolean(save), hidden: snap.text.includes("attacker.test") });

    // BR2 BR6: a click asks in Chat. Approved, it runs; denied, nothing runs.
    const clicking = call("click", { tabId: shared, controlId: save });
    const asked = await answer(sidebar, "approve", "chat-bridge");
    const clicked = await clicking;
    check("BR2 a click from Claude Code asks for approval in Chat, then runs", { tool: "click", domain: "127.0.0.1", error: false, page: "Subscribed." },
      { tool: JSON.parse(asked.text).tool, domain: JSON.parse(asked.text).domain, error: clicked.isError, page: await page.evaluate(() => document.getElementById("done").textContent) });
    const denying = call("click", { tabId: shared, controlId: save });
    await answer(sidebar, "deny");
    check("BR6 a denied click reaches Claude Code as approval-denied", true, (await denying).text.includes("approval-denied"));
    const unshared = await call("snapshot", { tabId: other });
    check("BR1 a call to a tab that is not shared is denied", { error: true, code: true }, { error: unshared.isError, code: unshared.text.includes("not-shared") });

    // BR8: Stop while an approval waits.
    const waiting = call("click", { tabId: shared, controlId: save });
    await poll(sidebar, () => Boolean([...document.querySelectorAll("li.ask")].findLast((l) => l.querySelector(".row button"))), undefined, 30_000);
    await sidebar.evaluate(() => document.getElementById("bridge-stop").click());
    const stopped = await waiting;
    const after = await call("list_tabs");
    check("BR8 Stop ends the session: the waiting call gets host-gone, the next bridge-off", { stopped: true, after: true, status: "Not shared." },
      { stopped: stopped.text.includes("host-gone"), after: after.text.includes("bridge-off"), status: await status("Not shared.") });

    // BR7: share again, then the tab moves to another host.
    await sidebar.evaluate((id) => window.foxmate.share(id), shared);
    await status("Waiting for Claude Code");
    await page.goto(`${site.url.replace("127.0.0.1", "localhost")}/bridge.html`);
    const moved = await call("snapshot", { tabId: shared });
    check("BR7 a shared tab that moved to another host is no longer shared", { code: true, status: true },
      { code: moved.text.includes("not-shared"), status: (await status("left")).includes("stopped sharing") });
  } finally {
    await client.close().catch(() => undefined);
    await sidebar.evaluate(() => document.getElementById("bridge-stop").click()).catch(() => undefined);
    files.forEach((file, i) => (saved[i] ? copyFileSync(join(work, `saved-${i}`), file) : rmSync(file, { force: true })));
    for (const dir of fresh) rmSync(dir, { recursive: true, force: true });
    await site.close();
  }
}
