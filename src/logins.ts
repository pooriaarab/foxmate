// Saved logins: the user saves a host, a username and a password in
// Settings. A login vault (foxvault) keeps the password. At a sign-in wait,
// the user can ask foxmate to fill it: foxpass's fillWall writes it only into
// the field that the scan found as the sign-in step, after the user approves
// foxgate's exact fill. The planner never asks for a fill, and never gets
// the value (docs/failure-modes.md LV1-LV14).
import { createFoxgate, type Host, type PublicSuffix } from "foxgate";
import type { ApprovalRequest } from "foxloop";
import { fillWall, scanTab, type FieldInfo, type ScanBrowser, type TabScan } from "foxpass";
import { FILL_TOOL, type FillBrowser, type Vault } from "foxvault";
import { createApprovals, type Answer, type Waiting } from "./approvals.js";
import type { Trail } from "./agent.js";

/** One saved login. The password is in the login vault under `handle`. */
export interface LoginRecord {
  host: string;
  handle: string;
  /** Not a secret: Settings shows it. Empty when the user saved none. */
  username: string;
}

export interface LoginStore {
  get(): Promise<LoginRecord[]>;
  set(records: LoginRecord[]): Promise<void>;
}

export type LoginVault = Pick<Vault, "status" | "initialize" | "set" | "remove" | "fill" | "redact">;

export type LoginEvent =
  | { type: "login-approval"; requestId: string; action: ApprovalRequest["action"]; expiresAt: number; detail: string; exactText: string }
  | { type: "login-fill"; host?: string; status: FillEnd["status"]; reason?: string };

export interface FillEnd {
  status: "filled" | "denied" | "refused";
  host?: string;
  reason?: string;
}

/** The part of `browser.scripting` that the stand-in uses. */
export interface FrameScripting {
  executeScript(injection: never): Promise<{ result?: unknown; documentId?: string }[]>;
}

/** The fill's own foxgate: one tool, foxvault.fill. The planner's gate never knows it (LV4, LV14). */
export function loginGate(publicSuffix?: PublicSuffix) {
  return createFoxgate({ tools: { [FILL_TOOL]: "fill" }, ...(publicSuffix ? { publicSuffix } : {}) });
}

/**
 * foxvault and foxpass read the top document of the tab with
 * webNavigation.getFrame. foxmate has no webNavigation permission (HP8), so
 * this stand-in asks frame 0 for its address; Firefox reports the
 * documentId with the result (LV13).
 */
export function frameBrowser(browser: { scripting: FrameScripting }): ScanBrowser & FillBrowser {
  return {
    webNavigation: {
      async getFrame({ tabId }) {
        const [top] = await browser.scripting.executeScript({ target: { tabId, frameIds: [0] }, func: () => location.href } as never).catch(() => []);
        if (typeof top?.result !== "string") return undefined;
        return top.documentId ? { url: top.result, documentId: top.documentId } : { url: top.result };
      },
    },
    scripting: browser.scripting as never,
  };
}

/**
 * Runs in the page. It writes the username only into an empty input on the
 * page's own host. Firefox sends it as source text, so it uses nothing from
 * outside its body.
 */
export function fillUsername(selector: string, value: string, host: string): string {
  if (location.hostname !== host) return "host-changed";
  const input = document.querySelector(selector);
  if (!(input instanceof HTMLInputElement) || input.value !== "") return "not-a-field";
  input.focus();
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
  return "filled";
}

/** The host of a site that the user typed: a host name or an address. */
export function loginHost(site: string): string {
  const text = site.trim().toLowerCase();
  let host: string;
  try {
    host = new URL(/^[a-z][a-z0-9+.-]*:\/\//.test(text) ? text : `https://${text}`).hostname;
  } catch {
    throw new Error("Type the site as a host name, for example bank.example.com.");
  }
  if (!host || (host !== "localhost" && !host.includes("."))) throw new Error("Type the site as a host name, for example bank.example.com.");
  return host;
}

/** A host on this computer. Only there may a fill write into a plain http page (LV10). */
export const isLocalHost = (host: string) => host === "localhost" || host.endsWith(".localhost") || host === "127.0.0.1" || host === "[::1]";

const IDENTIFIER = /\b(user|username|login|email|e-mail|account)\b/i;
const isIdentifier = (f: FieldInfo) => f.type === "email" || /\b(username|email)\b/i.test(f.autocomplete) || (f.type === "text" && IDENTIFIER.test(`${f.name} ${f.id} ${f.label} ${f.placeholder}`));
const named = (f: FieldInfo) => `${f.label || f.name || f.id || "a field"} (${f.selector})`;

export interface LoginsOptions {
  vault: LoginVault;
  /** The host side of loginGate(). */
  host: Host;
  store: LoginStore;
  browser: ScanBrowser & { scripting: FrameScripting };
  trail: Trail;
  /** How long a fill grant lives. Default 2 minutes. */
  grantMs?: number;
}

export function createLogins(options: LoginsOptions) {
  const { vault, host, store, browser, trail } = options;
  const approvals = createApprovals({ host, trail });
  const grants = new Set<string>();
  let filling = false;
  let opened: Promise<void> | undefined;
  // Device mode: the vault opens with no passphrase.
  const ready = () => (opened ??= vault.status().then(async (s) => {
    if (s === "new") await vault.initialize();
  }).catch((error: unknown) => {
    opened = undefined;
    throw error;
  }));
  const forHost = async (h: string) => (await store.get()).find((r) => r.host === h);

  async function save(input: { site: string; username: string; password: string }): Promise<{ host: string }> {
    const site = loginHost(input.site);
    await ready();
    const old = await forHost(site);
    const handle = `vault:login-${[...crypto.getRandomValues(new Uint8Array(4))].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
    // foxvault checks the value (8 to 4096 characters) and never echoes it.
    await vault.set(handle, input.password, { domains: [site], allowHttp: isLocalHost(site) });
    if (old) await vault.remove(old.handle);
    await store.set([...(await store.get()).filter((r) => r.host !== site), { host: site, handle, username: input.username.trim() }]);
    await trail.append({ actor: "user", kind: "login.save", data: { host: site, handle } });
    return { host: site };
  }

  async function remove(site: string): Promise<boolean> {
    const old = await forHost(site);
    if (!old) return false;
    await ready();
    await vault.remove(old.handle);
    await store.set((await store.get()).filter((r) => r.host !== site));
    await trail.append({ actor: "user", kind: "login.remove", data: { host: site, handle: old.handle } });
    return true;
  }

  /** Fills the saved login into the sign-in form of the tab, after the user approves. */
  async function fill(tabId: number, emit: (event: LoginEvent) => void): Promise<FillEnd> {
    if (filling) return { status: "refused", reason: "busy" };
    filling = true;
    let end: FillEnd = { status: "refused", reason: "error" };
    let fillHost: string | undefined;
    let handle: string | undefined;
    let username = false;
    try {
      await ready();
      let scan: TabScan;
      try {
        scan = await scanTab(browser, tabId);
      } catch {
        return (end = { status: "refused", reason: "no-scan" });
      }
      const walls = scan.walls.filter((w) => w.kind === "password" && w.selector !== undefined && !/new-password/.test(scan.scan.fields.find((f) => f.selector === w.selector)?.autocomplete ?? ""));
      if (!walls.length) return (end = { status: "refused", reason: "no-password-field" });
      // The saved host must equal the wall's host: no look-alike, no subdomain (LV2).
      const saved = await store.get();
      const wall = walls.find((w) => saved.some((r) => r.host === w.host));
      const record = wall && saved.find((r) => r.host === wall.host);
      if (!wall || !record) return (end = { status: "refused", reason: "no-login" });
      fillHost = wall.host;
      handle = record.handle;
      const password = scan.scan.fields.find((f) => f.selector === wall.selector)!;
      const user = record.username && password.form >= 0
        ? scan.scan.fields.find((f) => f.form === password.form && f.visible && !f.filled && f.type !== "password" && isIdentifier(f))
        : undefined;
      const { id } = await host.addGrant({ scope: "fill", domains: [wall.host], tools: [FILL_TOOL], approval: "always", expiresAt: Date.now() + (options.grantMs ?? 120_000) });
      grants.add(id);
      const ask = await fillWall({ vault, handle: record.handle, tabId, scan, wall });
      if (ask.status === "refused") return (end = { status: "refused", host: wall.host, reason: ask.reason });
      if (ask.status !== "ask") return (end = { status: "refused", host: wall.host, reason: "no-approval" });
      const request = (await host.pending()).find((r) => r.id === ask.requestId);
      if (!request) return (end = { status: "refused", host: wall.host, reason: "no-approval" });
      const detail = `Fill the saved password for ${wall.host} into ${named(password)}${user ? `, and the saved username into ${named(user)}` : ""}. Then press the page's sign-in button yourself.`;
      approvals.expect(request.id);
      emit({ type: "login-approval", requestId: request.id, action: request.action, expiresAt: request.expiresAt, detail, exactText: request.text });
      const token = await approvals.ask({ step: 0, requestId: request.id, action: request.action, expiresAt: request.expiresAt, detail });
      if (!token) return (end = { status: "denied", host: wall.host });
      const done = await fillWall({ vault, handle: record.handle, tabId, scan, wall, token });
      if (done.status !== "filled") return (end = { status: "refused", host: wall.host, reason: done.status === "refused" ? done.reason : "no-approval" });
      // The username goes into the same document, after the approved password fill (LV11).
      if (user && scan.documentId) {
        const [result] = await browser.scripting.executeScript({ target: { tabId, documentIds: [scan.documentId] }, func: fillUsername, args: [user.selector, record.username, wall.host] } as never).catch(() => []);
        username = result?.result === "filled";
      }
      return (end = { status: "filled", host: wall.host });
    } finally {
      for (const id of grants) await host.revokeGrant(id).catch(() => undefined);
      grants.clear();
      filling = false;
      emit({ type: "login-fill", ...(end.host ? { host: end.host } : {}), status: end.status, ...(end.reason ? { reason: end.reason } : {}) });
      await trail.append({ actor: "foxmate", kind: "login.fill", data: { host: fillHost ?? null, handle: handle ?? null, status: end.status, ...(end.reason ? { reason: end.reason } : {}), ...(end.status === "filled" ? { username } : {}) } }).catch(() => undefined);
    }
  }

  return {
    save,
    remove,
    /** The saved logins: host and username. Never the password. */
    list: async () => (await store.get()).map(({ host: h, username: u }) => ({ host: h, username: u })),
    has: async (h: string) => Boolean(await forHost(h)),
    /** Replaces each saved password, and its usual encodings, with its handle. */
    redact: async (text: string) => {
      await ready();
      return vault.redact(text);
    },
    fill,
    /** Only the sidebar can answer a fill (LV7). */
    answer: async (requestId: string, answer: Answer, via: string) => (via === "sidebar" ? approvals.answer(requestId, answer, via) : "unknown" as const),
    waiting: (): Waiting[] => approvals.waiting(),
    onChange: (fn: (waiting: Waiting[]) => void) => approvals.onChange(fn),
    /** The sign-in wait ended: its open fill requests end as no, and the grants go (LV8). */
    async end() {
      approvals.cancelAll();
      for (const id of grants) await host.revokeGrant(id).catch(() => undefined);
      grants.clear();
    },
  };
}

export type Logins = ReturnType<typeof createLogins>;
