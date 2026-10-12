// The sign-in handoff: before each page read, foxpass scans the tab. On a
// sign-in, code, passkey, CAPTCHA or consent wall, the run waits until the
// user does the step. Each snapshot then passes foxpass's redaction, so a
// typed secret never reaches the planner (docs/failure-modes.md HP1-HP9).
// With saved logins, the user can ask foxmate to fill the sign-in while the
// run waits (LV1-LV14).
import { createHandoff, messageFor, redactSnapshot, scanTab, type FieldInfo, type HandoffBrowser, type Notice, type SnapshotField, type Wall } from "foxpass";
import type { Snapshot } from "foxpaw";
import type { Trail } from "./agent.js";
import type { FillEnd, LoginEvent, Logins } from "./logins.js";

/** The parts of `browser` that foxmate gives foxpass. No webNavigation (HP8). */
export interface PassBrowser {
  tabs: HandoffBrowser["tabs"] & { get(tabId: number): Promise<{ url?: string; status?: string; windowId?: number }> };
  windows: HandoffBrowser["windows"];
  scripting: HandoffBrowser["scripting"];
  cookies?: HandoffBrowser["cookies"];
}

export type PassEvent = { type: "handoff"; host: string; kind: Wall["kind"]; message: string; fill: boolean } | { type: "handoff-end"; status: string } | LoginEvent;

export interface PassOptions {
  browser: PassBrowser;
  trail: Trail;
  /** How long the user has. Default: foxpass's 5 minutes. */
  timeoutMs?: number;
  /** Tell the user outside the sidebar, for example with foxnotify. */
  onNeedsUser?: (notice: Notice) => void | Promise<void>;
  /** Saved logins: Chat offers a fill at a wait on a host that has one. */
  logins?: Logins;
}

/** A sign-in wait that ended with no sign-in. `status` is foxpass's end status, such as "timeout" (HP15). */
export class HandoffError extends Error {
  readonly status: string;
  constructor(message: string, status?: string) {
    super(message);
    this.status = status ?? /\(([\w-]+)\)/.exec(message)?.[1] ?? "ended";
  }
}

/** foxpass's browser. The stand-in reads the tab address, so foxpass scans the top frame of the tab (HP8). */
function handoffBrowser(browser: PassBrowser): HandoffBrowser {
  const getFrame = async ({ tabId }: { tabId: number }) => ({ url: (await browser.tabs.get(tabId)).url ?? "" });
  return { tabs: browser.tabs, windows: browser.windows, scripting: browser.scripting, webNavigation: { getFrame }, ...(browser.cookies ? { cookies: browser.cookies } : {}) };
}

/**
 * The goal names a password, PIN or passcode, such as `the password "fE4"`,
 * `update the password to '1j1l'` or `password Tr4il-Mix-2026`. The user gave it, so there is no step left for them (HP14).
 */
const GOAL_PASSWORD = /\b(?:pass(?:word|code|phrase)|PIN)\b(?:\s+(?:is|to|as))?\s*:?\s*["'“‘]([^\s"'“”‘’]{1,128})["'”’]/gi;
/** Or with no quotes: a word of 6 or more characters with a digit or a symbol, as in `password Tr4il-Mix-2026` (HP14). */
const BARE_PASSWORD = /\b(?:pass(?:word|code|phrase)|PIN)\b(?:\s+(?:is|to|as))?\s*:?\s+(?=\S*[\d!@#$%^&*_+=~-])(?!\S*["'“”‘’])(\S{6,128})/gi;
/** Each password the goal names (HP14), for the wall check and for masking the trail and events (HP16). */
export function goalPasswords(goal: string | undefined): string[] {
  const text = goal ?? "";
  const quoted = [...text.matchAll(GOAL_PASSWORD)].map((m) => m[1]!);
  const bare = [...text.matchAll(BARE_PASSWORD)].map((m) => m[1]!.replace(/[,.;:)]+$/, ""));
  return [...new Set([...quoted, ...bare])].filter(Boolean);
}
export const goalGivesPassword = (goal: string | undefined) => goalPasswords(goal).length > 0;

/** Every string in `value` with each password masked as "•••" (HP16). */
export function maskPasswords<T>(value: T, passwords: readonly string[]): T {
  const hidden = passwords.filter((p) => p.length >= 2);
  if (!hidden.length) return value;
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") return hidden.reduce((text, p) => text.split(p).join("•••"), v);
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object" && Object.getPrototypeOf(v) === Object.prototype) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  return walk(value) as T;
}
/** The walls a password from the goal answers (HP14). A code, passkey, CAPTCHA or consent still needs the user. */
const ANSWERED = new Set<Wall["kind"]>(["password", "sign-in"]);

/** A password field for a new password is a sign-up: the planner fills it (HP9). */
const signUp = (wall: Wall, fields: FieldInfo[]) => wall.kind === "password" && /\bnew-password\b/.test(fields.find((f) => f.selector === wall.selector)?.autocomplete ?? "");

export function createPass(options: PassOptions) {
  const browser = handoffBrowser(options.browser);
  const handoff = createHandoff({ browser, ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}), ...(options.onNeedsUser ? { onNeedsUser: options.onNeedsUser } : {}) });
  const hints = new Map<number, FieldInfo[]>();
  const log = (kind: string, data: unknown) => options.trail.append({ actor: "foxpass", kind, data });
  // The sign-in wait in progress, for a fill click from Chat.
  let waiting: { tabId: number; emit: (event: PassEvent) => void } | undefined;

  /** Waits for the user when the tab shows a wall. Throws HandoffError when the user does not finish. */
  async function beforeRead(tabId: number, run: { signal?: AbortSignal; emit: (event: PassEvent) => void; goal?: string }): Promise<void> {
    let scan;
    try {
      scan = await scanTab(browser, tabId);
    } catch (error) {
      await log("handoff.scan-failed", { message: error instanceof Error ? error.message : String(error) });
      return;
    }
    hints.set(tabId, scan.scan.fields);
    const all = scan.walls.filter((w) => !signUp(w, scan.scan.fields));
    const walls = goalGivesPassword(run.goal) ? all.filter((w) => !ANSWERED.has(w.kind)) : all;
    // The log keeps the kinds only, never the goal's password (HP6, HP14).
    if (walls.length < all.length) await log("handoff.skipped", { reason: "goal-password", kinds: all.filter((w) => !walls.includes(w)).map((w) => w.kind) });
    const [wall] = walls;
    if (!wall) return;
    const fill = Boolean(await options.logins?.has(wall.host).catch(() => false));
    run.emit({ type: "handoff", host: wall.host, kind: wall.kind, message: messageFor(wall), fill });
    await log("handoff.paused", { host: wall.host, kinds: walls.map((w) => w.kind) });
    waiting = { tabId, emit: run.emit };
    let result;
    try {
      result = await handoff.toUser({ tabId, walls, ...(run.signal ? { signal: run.signal } : {}) });
    } finally {
      waiting = undefined;
      await options.logins?.end();
    }
    run.emit({ type: "handoff-end", status: result.status });
    await log("handoff.ended", { status: result.status });
    // The page changed under the user: read the newest fields next time.
    hints.delete(tabId);
    if (result.status !== "signed-in" && result.status !== "no-wall") throw new HandoffError(`The user did not finish the sign-in step (${result.status}). Stop, and tell the user.`, result.status);
  }

  /** The user asks to fill the saved login into the tab that the run waits on. */
  async function fillSaved(): Promise<FillEnd> {
    if (!waiting || !options.logins) return { status: "refused", reason: "no-wait" };
    return options.logins.fill(waiting.tabId, waiting.emit);
  }

  return { beforeRead, fillSaved, hints: (tabId: number) => hints.get(tabId) ?? [] };
}

export type Pass = ReturnType<typeof createPass>;

/**
 * foxpass's redaction on a foxpaw snapshot and on foxshield's quotes. foxpaw
 * has no autocomplete text, so each control gets the hint of the scanned
 * field with the same type and name or label (HP5).
 */
export function redactPage(page: Snapshot, hints: FieldInfo[], quotes: string[] = []): { page: Snapshot; quotes: string[] } {
  const fields: SnapshotField[] = page.controls.map((c) => {
    const hint = hints.find((f) => f.type === c.type && ((f.name !== "" && f.name === c.name) || (f.label !== "" && f.label === c.label)));
    return { type: c.type, name: c.name, label: c.label, placeholder: c.placeholder, value: c.value, secret: c.secret, autocomplete: hint?.autocomplete ?? "", inputMode: hint?.inputMode ?? "", maxLength: hint?.maxLength ?? -1 };
  });
  const safe = redactSnapshot({ text: page.text, title: page.title, quotes, fields });
  const controls = page.controls.map((c, i) => ({ ...c, value: String(safe.fields?.[i]?.value ?? c.value) }));
  return { page: { ...page, title: safe.title, text: safe.text, controls }, quotes: safe.quotes };
}

const CARD = /(?<![\d-])\d(?:[ -]?\d){12,18}(?![\d-])/g;
/** The Luhn check that every payment card number passes. */
function luhn(digits: string): boolean {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) d = d * 2 > 9 ? d * 2 - 9 : d * 2;
    sum += d;
  }
  return sum % 10 === 0;
}
// A code after its name: a card code, a one-time code or a PIN.
const CODE = /\b(CVC2?|CVV2?|CSC|CID|security code|one-time code|verification code|sign-in code|login code|OTP|passcode|PIN)(\s*[:=]?\s*)\d{3,8}\b/gi;
// A bank account number after its name; it keeps its last 4 digits.
const ACCOUNT = /\b(account number|account no\.?|account #|routing number|IBAN)(\s*[:=#]?\s*)([A-Z]{2}\d{2} ?)?\d[\d -]{2,30}\d\b/gi;
/**
 * Each card number in the text as "•••• 4242", its last 4 digits only, each card code, one-time code
 * or PIN as "•••", and each account number as "•••• 6789" (G37, G39).
 */
export function maskCards(text: string): string {
  return text.replace(CARD, (found) => {
    const digits = found.replace(/\D/g, "");
    return luhn(digits) ? `•••• ${digits.slice(-4)}` : found;
  }).replace(CODE, (_found, name: string, gap: string) => `${name}${gap}•••`)
    .replace(ACCOUNT, (found: string, name: string, gap: string) => `${name}${gap}•••• ${found.replace(/\D/g, "").slice(-4)}`);
}

const ID = /(^id|Id)$/;
/**
 * A copy of `value` with maskCards on each string in it, for what a page shows and what the trail keeps
 * (G40, G41). A string under a key that ends in "id" or "Id" stays, so an answer finds its request (G43).
 */
export function maskSecrets<T>(value: T, key = ""): T {
  if (typeof value === "string") return (ID.test(key) ? value : maskCards(value)) as T;
  if (Array.isArray(value)) return value.map((item) => maskSecrets(item)) as T;
  if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, maskSecrets(v, k)])) as T;
  }
  return value;
}
