// Tests for docs/failure-modes.md LV1-LV14: a saved login, filled from a
// real foxvault through a real foxgate and foxpass's fillWall. Only the tab
// is a stub: it answers foxpass's scan and foxvault's fill like a page.
import type { LoopTool, Message } from "foxloop";
import { scanPage, type FieldInfo, type PageScan } from "foxpass";
import { Log, MemoryStore, generateKey } from "foxtrail";
import { FILL_TOOL, createVault, fillField } from "foxvault";
import { describe, expect, it } from "vitest";
import { createAgent } from "../src/agent.js";
import { createLogins, fillUsername, frameBrowser, loginGate, type LoginEvent, type LoginRecord } from "../src/logins.js";
import { createPass } from "../src/pass.js";

const PASSWORD = "plum-Kettle-58";
const USERNAME = "sam@bank.example";

const field = (more: Partial<FieldInfo>): FieldInfo => ({
  selector: "#x", tag: "input", type: "text", autocomplete: "", name: "", id: "", label: "", placeholder: "", inputMode: "", maxLength: -1, visible: true, filled: false, form: 0, ...more,
});
const SIGN_IN = [
  field({ selector: "#email", type: "email", autocomplete: "username", name: "email", id: "email", label: "Email" }),
  field({ selector: "#password", type: "password", autocomplete: "current-password", name: "password", id: "password", label: "Password" }),
];

interface Page { url: string; documentId: string; fields: FieldInfo[]; frames?: string[] }

/** One tab. `values` is what the page fields hold, as the page sees them. */
function fakeTab(start: Page) {
  let page = start;
  const values = new Map<string, string>();
  const calls: string[] = [];
  const scan = (): PageScan => ({ url: page.url, title: "Sign in", headings: ["Sign in to your bank"], fields: page.fields, buttons: [{ text: "Sign in", form: 0, visible: true }], frames: page.frames ?? [], captchaMarks: [], webauthn: [] });
  const scripting = {
    async executeScript(injection: { target: { tabId: number; documentIds?: string[]; frameIds?: number[] }; func: (...args: never[]) => unknown; args?: unknown[] }) {
      if (injection.target.documentIds && !injection.target.documentIds.includes(page.documentId)) throw new Error("No document with that id");
      const at = { frameId: 0, documentId: page.documentId };
      if (injection.func === (scanPage as unknown)) return [{ ...at, result: scan() }];
      if (injection.func === (fillField as unknown) || injection.func === (fillUsername as unknown)) {
        const [selector, value, host] = injection.args as string[];
        calls.push(`${injection.func === (fillField as unknown) ? "password" : "username"} ${selector}`);
        if (new URL(page.url).hostname !== host) return [{ ...at, result: "host-changed" }];
        values.set(selector!, value!);
        return [{ ...at, result: "filled" }];
      }
      return [{ ...at, result: page.url }];
    },
  };
  return { browser: { scripting }, values, calls, go: (next: Page) => { page = next; } };
}

async function setup(page: Page, saved: { site: string; username?: string; password?: string } = { site: "127.0.0.1", username: USERNAME, password: PASSWORD }) {
  const tab = fakeTab(page);
  const trail = new Log({ store: new MemoryStore(), key: await generateKey() });
  const { gate, host } = loginGate();
  const vault = createVault({ gate, browser: frameBrowser(tab.browser), onEvent: async (e) => { await trail.append({ actor: "foxvault", kind: `vault.${e.type}`, data: { kind: e.kind, handle: e.handle, host: e.host ?? null, reason: e.reason ?? null } }); } });
  let records: LoginRecord[] = [];
  const logins = createLogins({ vault, host, browser: frameBrowser(tab.browser), trail, store: { get: async () => records, set: async (r) => { records = r; } } });
  await logins.save({ site: saved.site, username: saved.username ?? "", password: saved.password ?? PASSWORD });
  const events: LoginEvent[] = [];
  /** Starts a fill. The human answers each approval with `answer`, from `via`. */
  const fill = (answer: "approve" | "deny" | "none" = "approve", via = "sidebar") => logins.fill(1, (event) => {
    events.push(event);
    if (event.type === "login-approval" && answer !== "none") void logins.answer(event.requestId, answer, via);
  });
  return { tab, trail, logins, host, events, fill, records: () => records };
}

const BANK = { url: "http://127.0.0.1:8790/login", documentId: "doc-1", fields: SIGN_IN };

describe("logins", () => {
  it("LV1: a page that repeats the password reaches the planner with the handle in its place", async () => {
    const { logins, records } = await setup(BANK);
    const seen: string[] = [];
    const replies = [{ name: "snapshot", args: {} }, { name: "finish", args: { summary: "Read it." } }];
    const mind = {
      async chat(messages: Message[]) {
        seen.push(JSON.stringify(messages));
        const call = replies.shift()!;
        return { message: { role: "assistant" as const, content: null, tool_calls: [{ id: `c${seen.length}`, type: "function" as const, function: { name: call.name, arguments: JSON.stringify(call.args) } }] } };
      },
    };
    const snapshot: LoopTool = { name: "snapshot", description: "Read.", parameters: { type: "object", properties: {} }, scope: "read", domain: () => "127.0.0.1", run: async () => ({ ok: true, summary: "Read.", untrusted: `Wrong password: ${PASSWORD}. Try again.` }) };
    const agent = createAgent({ browser: { tabs: { get: async (id: number) => ({ id, url: "http://127.0.0.1:8790/login" }) } }, trail: { append: async () => undefined }, makeTools: () => [snapshot], pageProblem: async () => undefined, redact: (text) => logins.redact(text), runMs: 60_000 });
    await agent.run({ goal: "Read the page.", tabId: 1, settings: {}, mind });
    expect(seen.length).toBeGreaterThan(1);
    expect(seen.join("\n")).not.toContain(PASSWORD);
    expect(seen.join("\n")).toContain(records()[0]!.handle);
  });

  it("LV2: no fill on a look-alike host or another host than the saved one", async () => {
    const { tab, fill, logins } = await setup({ ...BANK, url: "http://127.0.0.1.evil.test/login" });
    expect(await logins.has("127.0.0.1.evil.test")).toBe(false);
    expect(await fill()).toMatchObject({ status: "refused", reason: "no-login" });
    expect([...tab.values.values()]).toEqual([]);
  });

  it("LV3: a sign-in form in an iframe is not filled", async () => {
    const { tab, fill } = await setup({ ...BANK, fields: [], frames: ["https://login.bank.example/frame"] });
    expect(await fill()).toMatchObject({ status: "refused", reason: "no-password-field" });
    expect(tab.calls).toEqual([]);
  });

  it("LV4: nothing is filled before the Approve, and nothing after a Deny", async () => {
    const { tab, fill, events, host } = await setup(BANK);
    const grants = (await host.grants()).length;
    expect(await fill("deny")).toMatchObject({ status: "denied" });
    expect(tab.calls).toEqual([]);
    expect(events.filter((e) => e.type === "login-approval")).toHaveLength(1);
    // The only grant it ever adds asks a human, and it is gone after the fill.
    expect((await host.grants()).length).toBe(grants);
    expect(events.find((e) => e.type === "login-fill")).toMatchObject({ status: "denied", host: "127.0.0.1" });
  });

  it("LV5: the approval is foxgate's exact fill, with the host and the field", async () => {
    const { fill, events, records } = await setup(BANK);
    expect(await fill()).toMatchObject({ status: "filled", host: "127.0.0.1" });
    const ask = events.find((e) => e.type === "login-approval");
    expect(ask && JSON.parse(ask.exactText)).toMatchObject({ tool: FILL_TOOL, scope: "fill", domain: "127.0.0.1", args: { handle: records()[0]!.handle, selector: "#password" } });
    expect(ask?.detail).toContain("127.0.0.1");
    expect(ask?.detail).toContain("Password (#password)");
    expect(ask?.detail).toContain("Email (#email)");
  });

  it("LV6: the log holds the handle and the host of the release, never the value", async () => {
    const { fill, trail, records } = await setup(BANK);
    await fill();
    const log = JSON.stringify(await trail.entries());
    expect(log).not.toContain(PASSWORD);
    expect(log).not.toContain(USERNAME);
    const release = (await trail.entries()).find((e) => e.kind === "vault.release");
    expect(release?.data).toEqual({ kind: "fill", handle: records()[0]!.handle, host: "127.0.0.1", reason: null });
    expect((await trail.entries()).find((e) => e.kind === "login.fill")?.data).toEqual({ host: "127.0.0.1", handle: records()[0]!.handle, status: "filled", username: true });
    // An entry that holds the value passes the login vault's redact first.
    expect(await (await setup(BANK)).logins.redact(`typed ${PASSWORD}`)).not.toContain(PASSWORD);
  });

  it("LV7: an answer from the phone does not decide a fill", async () => {
    const { tab, fill, logins } = await setup(BANK);
    const done = fill("approve", "phone");
    await new Promise((r) => setTimeout(r, 50));
    expect(logins.waiting()).toHaveLength(1);
    expect(tab.calls).toEqual([]);
    await logins.end();
    expect(await done).toMatchObject({ status: "denied" });
    expect(tab.calls).toEqual([]);
  });

  it("LV8: a fill click with no sign-in wait is refused, and the end of the wait stops a fill", async () => {
    const { tab, fill, logins, records } = await setup(BANK);
    const browser = { tabs: { get: async () => ({ url: BANK.url, status: "complete" }), update: async () => ({}) }, windows: { update: async () => ({}) }, scripting: tab.browser.scripting };
    const pass = createPass({ browser, trail: { append: async () => undefined }, logins });
    expect(await pass.fillSaved()).toMatchObject({ status: "refused", reason: "no-wait" });
    const waiting = fill("none");
    await new Promise((r) => setTimeout(r, 50));
    await logins.end();
    expect(await waiting).toMatchObject({ status: "denied" });
    expect(tab.calls).toEqual([]);
    expect(records()).toHaveLength(1);
  });

  it("LV9: a page that changed after the scan is not filled", async () => {
    const { tab, logins } = await setup(BANK);
    const result = await logins.fill(1, (event) => {
      if (event.type !== "login-approval") return;
      tab.go({ ...BANK, documentId: "doc-2" });
      void logins.answer(event.requestId, "approve", "sidebar");
    });
    expect(result).toMatchObject({ status: "refused", reason: "page-changed" });
    expect(tab.calls).toEqual([]);
  });

  it("LV10: a plain http page on the network is not filled", async () => {
    const { tab, fill } = await setup({ ...BANK, url: "http://bank.example/login" }, { site: "bank.example", username: USERNAME });
    expect(await fill()).toMatchObject({ status: "refused", reason: "http" });
    expect(tab.calls).toEqual([]);
    const secure = await setup({ ...BANK, url: "https://bank.example/login" }, { site: "https://bank.example/login", username: USERNAME });
    expect(await secure.fill()).toMatchObject({ status: "filled", host: "bank.example" });
  });

  it("LV11: the username goes only into the empty username field of the approved form", async () => {
    const other = [field({ selector: "#search", type: "text", name: "q", label: "Search the help", form: 1 })];
    const { tab, fill } = await setup({ ...BANK, fields: [...SIGN_IN, ...other] });
    await fill();
    expect(tab.calls).toEqual(["password #password", "username #email"]);
    expect(Object.fromEntries(tab.values)).toEqual({ "#password": PASSWORD, "#email": USERNAME });
    const typed = await setup({ ...BANK, fields: [{ ...SIGN_IN[0]!, filled: true }, SIGN_IN[1]!] });
    await typed.fill();
    expect(typed.tab.calls).toEqual(["password #password"]);
  });

  it("LV14: the planner has no fill tool", async () => {
    const agent = createAgent({ browser: { tabs: { get: async (id: number) => ({ id, url: BANK.url }) } }, trail: { append: async () => undefined }, pageProblem: async () => undefined });
    const tools = (await agent.host.grants()).map((g) => g.tools ?? []).flat();
    expect(tools).not.toContain(FILL_TOOL);
    await expect(agent.gate.check({ tool: FILL_TOOL, scope: "fill", domain: "127.0.0.1", args: { handle: "vault:login-00000000", selector: "#password" } })).resolves.toMatchObject({ decision: "deny" });
  });
});
