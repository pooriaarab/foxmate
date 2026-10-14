// The sign-in handoff: before each page read, foxpass scans the tab. On a
// sign-in, code, passkey, CAPTCHA or consent wall, the run waits until the
// user does the step. Each snapshot then passes foxpass's redaction, so a
// typed secret never reaches the planner (docs/failure-modes.md HP1-HP9).
// With saved logins, the user can ask foxmate to fill the sign-in while the
// run waits (LV1-LV14).
import { createHandoff, messageFor, redactSnapshot, scanTab, type FieldInfo, type HandoffBrowser, type Notice, type SnapshotField, type Wall } from "foxpass";
import type { Snapshot } from "foxpaw";
import type { Trail } from "./agent.js";
import { isLocalHost, type FillEnd, type LoginEvent, type Logins } from "./logins.js";

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
const QUOTED = `\\s*:?\\s*["'“‘]([^\\s"'“”‘’]{1,128})["'”’]`;
// "PIN" counts only in capitals: "pin 'News' to the top" names no PIN (HP20).
// "to" counts only when the goal changes the password: "update the password to '1j1l'", never "email the password to 'ops'" (HP20).
const CHANGE = `\\b(?:change|update|set|reset)\\s+(?:(?:the|my|your|our)\\s+)?`;
const GOAL_PASSWORD = new RegExp(`\\bpass(?:word|code|phrase)\\b(?:\\s+is)?${QUOTED}`, "gi");
const GOAL_NEW_PASSWORD = new RegExp(`${CHANGE}pass(?:word|code|phrase)\\s+to${QUOTED}`, "gi");
const GOAL_PIN = new RegExp(`\\bPIN\\b(?:\\s+is)?${QUOTED}`, "g");
// The same words in any case with no "i" flag, so "PIN" itself stays in capitals.
const CHANGE_ANY_CASE = `\\b(?:[Cc]hange|[Uu]pdate|[Ss]et|[Rr]eset|CHANGE|UPDATE|SET|RESET)\\s+(?:(?:[Tt]he|[Mm]y|[Yy]our|[Oo]ur)\\s+)?`;
const GOAL_NEW_PIN = new RegExp(`${CHANGE_ANY_CASE}PIN\\s+to${QUOTED}`, "g");
/**
 * Or with no quotes: a word of 6 or more characters with a digit or a symbol, as in `password Tr4il-Mix-2026` (HP14).
 * Not after "to" or "as": "email the password to admin@corp.com" names an address, not a password (HP20).
 */
const BARE = `(?:\\s+is)?\\s*:?\\s+(?=\\S*[\\d!@#$%^&*_+=~-])(?!\\S*["'“”‘’])(\\S{6,128})`;
const BARE_PASSWORD = new RegExp(`\\bpass(?:word|code|phrase)\\b${BARE}`, "gi");
const BARE_PIN = new RegExp(`\\bPIN\\b${BARE}`, "g");
const QUOTED_FORMS = [GOAL_PASSWORD, GOAL_NEW_PASSWORD, GOAL_PIN, GOAL_NEW_PIN];
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const bareValue = (p: string) => p.replace(/[,.;:)]+$/, "");
/** Each password the goal names (HP14), for the wall check and for masking the trail and events (HP16). Never an email address (HP20). */
export function goalPasswords(goal: string | undefined): string[] {
  const text = goal ?? "";
  const quoted = QUOTED_FORMS.flatMap((re) => [...text.matchAll(re)].map((m) => ({ at: m.index, p: m[1]! })))
    .toSorted((a, b) => a.at - b.at).map((q) => q.p);
  const bare = [BARE_PASSWORD, BARE_PIN].flatMap((re) => [...text.matchAll(re)].map((m) => bareValue(m[1]!)));
  return [...new Set([...quoted, ...bare])].filter((p) => p && !EMAIL.test(p));
}
export const goalGivesPassword = (goal: string | undefined) => goalPasswords(goal).length > 0;

/** The goal with each password it names (the HP14 match) masked as "•••" (HP16). */
const maskGoal = (goal: string) => QUOTED_FORMS.reduce((g, re) => g.replace(re, (m, p: string) => m.replace(p, "•••")), goal)
  .replace(BARE_PASSWORD, (m, p: string) => m.replace(bareValue(p), "•••")).replace(BARE_PIN, (m, p: string) => m.replace(bareValue(p), "•••"));
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Every string in `value` with each password masked as "•••" (HP16), in any case, also URL-encoded: one of 6 or more
 * characters wherever it stands, also inside other words; one of 4 or 5 as a whole word that is no part of a host name; a shorter one only where a
 * string is that password, where it stands in double quotes, and in the goal.
 */
export function maskPasswords<T>(value: T, passwords: readonly string[], goal?: string): T {
  const long = [...new Set(passwords.filter((p) => p.length >= 4).flatMap((p) => [p, encodeURIComponent(p)]))];
  const inside = long.filter((p) => p.length >= 6);
  const edged = long.filter((p) => p.length < 6);
  const short = new Set(passwords.filter((p) => p.length > 0 && p.length < 4));
  if (!long.length && !short.size) return value;
  // From 6 characters also inside other words, so a call that hides it in "xPASSWORD" keeps it out of the trail (HP20);
  // a shorter one only as a whole word, so "test" leaves "testing" alone.
  // A dot joined to a letter or digit is no word edge: "shop.test" is a host name, not the password "test".
  const parts = [...inside.map(escape), ...edged.map((p) => `(?<![\\p{L}\\p{N}]|[\\p{L}\\p{N}]\\.)${escape(p)}(?![\\p{L}\\p{N}]|\\.[\\p{L}\\p{N}])`)];
  const words = parts.length ? new RegExp(`(?:${parts.join("|")})`, "giu") : undefined;
  const text = (t: string) => {
    if (short.has(t)) return "•••";
    let own = goal !== undefined && t === goal ? maskGoal(t) : t;
    // A short one also where it stands in quotes, as in a call's raw arguments: {"text":"fE4"}.
    for (const p of short) own = own.split(`"${p}"`).join('"•••"');
    return words ? own.replace(words, "•••") : own;
  };
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") return text(v);
    if (Array.isArray(v)) return v.map(walk);
    if (v instanceof Error) {
      const copy = new Error(text(v.message));
      copy.name = v.name;
      return copy;
    }
    if (v && typeof v === "object" && Object.getPrototypeOf(v) === Object.prototype) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  return walk(value) as T;
}
/** The run's own site for a sign-in wall: the tab's host at the run's start, or a subdomain of it (HP18). */
export const onRunSite = (host: string | undefined, runHost: string | undefined) => runHost !== undefined && host !== undefined && (host === runHost || host.endsWith(`.${runHost}`));

const webUrl = (url: string | undefined) => {
  try {
    const u = new URL(url ?? "");
    return u.protocol === "http:" || u.protocol === "https:" ? u : undefined;
  } catch {
    return undefined;
  }
};
const TLDS = new Set(["com", "net", "org", "io", "dev", "app", "co", "ai", "me", "info", "biz", "edu", "gov", "ca", "uk", "us", "de", "fr", "es", "it", "nl", "eu", "au", "jp", "test", "example", "local", "localhost"]);
/** The hosts the goal names (an address, or a name such as shop.test), without "www."; an email address names none (HP20). */
export function goalHosts(goal: string | undefined): string[] {
  const hosts = [...(goal ?? "").matchAll(/(?<![@\p{L}\p{N}_.-])((?:[\p{L}\p{N}](?:[\p{L}\p{N}-]*[\p{L}\p{N}])?\.)+(\p{L}{2,24}))(?![\p{L}\p{N}_@-]|\.[\p{L}\p{N}])/gu)]
    .filter((m) => TLDS.has(m[2]!.toLowerCase())).map((m) => webUrl(`https://${m[1]}`)?.hostname).filter((h): h is string => Boolean(h));
  // The URL parser gives the host as the address bar has it: lower case, letters outside ASCII as punycode.
  return [...new Set(hosts.map((h) => h.replace(/^www\./, "")))];
}

/**
 * Where a password the goal names may be typed (HP20): a page with the start tab's exact host, scheme and port, on https
 * unless the host is on this computer (as LV10), and, when the goal names hosts, a start host that is one of them.
 */
export function passwordSite(start: string | undefined, url: string, goal: string | undefined): boolean {
  const a = webUrl(start);
  const b = webUrl(url);
  if (!a || !b || a.protocol !== b.protocol || a.host !== b.host) return false;
  if (b.protocol !== "https:" && !isLocalHost(b.hostname)) return false;
  const named = goalHosts(goal);
  return !named.length || named.includes(a.hostname.replace(/^www\./, ""));
}

/** What a call does with a password the goal names, as foxloop pins it: a target with its password flag, page and frame address. */
interface Pinned { id?: unknown; secret?: unknown; url?: unknown; frameUrl?: unknown; request?: { value?: unknown } }

/** The tools that may type a password into a password field, and the page-derived fields foxloop's `prepare` adds (never scanned). */
const TYPING = new Set(["act", "fill", "fill_and_send"]);
const PREPARED: Record<string, readonly string[]> = { act: ["target"], click: ["target"], fill: ["targets"], fill_and_send: ["targets", "sendTarget"], browser_task: ["form"] };

/** Every string value in `value`; key names are the tool's own words, or control ids. */
const stringsIn = (value: unknown): string[] => typeof value === "string" ? [value]
  : Array.isArray(value) ? value.flatMap(stringsIn)
  : value && typeof value === "object" ? Object.values(value).flatMap(stringsIn) : [];
const bytes = (t: string) => t.replace(/%([0-9a-f]{2})/gi, (_, h: string) => String.fromCharCode(parseInt(h, 16)));
const decode = (t: string) => { try { return decodeURIComponent(t); } catch { return bytes(t); } };
/** A string as it is and each percent-decoding of it ("+" as a space), until it stops changing. */
function decodings(text: string): string[] {
  const out = [text];
  for (let next = decode(text.replace(/\+/g, " ")); next !== out.at(-1) && out.length < 7; next = decode(next.replace(/\+/g, " "))) out.push(next);
  return out.map((t) => t.toLowerCase());
}
const looksLikeAddress = (text: string) => /^[a-z][a-z0-9+.-]*:|^\/|[?&][^=\s]*=/i.test(text.trim());
const queryValues = (text: string) => [...text.matchAll(/[?&][^=&#\s]*=([^&#\s]*)/g)].flatMap((m) => decodings(m[1]!));

/**
 * A prepared call that carries a password the goal names anywhere but into a password field on the password site, through
 * act, fill or fill_and_send (HP20). `onSite` is passwordSite for the run. Only the values the model gave are scanned:
 * foxloop's pinned targets and browser_task's form preview come from the page. A partial defence: a password of 4 or more
 * characters is found in any case, inside other words and percent-encoded; in an address, any 6 characters of it in a row
 * are enough (on the password site, in its path and query only). A shorter one counts only as a whole value or a whole
 * query value. A password split into pieces under 6 characters, or encoded another way (base64, reversed), is not found.
 */
export function passwordElsewhere(tool: string, args: Record<string, unknown>, passwords: readonly string[], onSite: (url: string) => boolean): boolean {
  if (!passwords.length) return false;
  const rest = JSON.parse(JSON.stringify(args)) as Record<string, unknown> & { target?: Pinned; targets?: Pinned[]; fields?: Record<string, unknown> };
  // The password field must be on the password site, by the page address and by the address of its own frame (C1),
  // and the target must be one foxloop pinned for a tool that types.
  const allowed = (t: Pinned | undefined, value: unknown) => TYPING.has(tool) && t?.secret === true && typeof t.url === "string" && typeof t.frameUrl === "string"
    && t.frameUrl !== "" && onSite(t.url) && onSite(t.frameUrl) && typeof value === "string" && passwords.includes(value);
  if (tool === "act" && allowed(rest.target, rest.value)) delete rest.value;
  if (tool === "fill" || tool === "fill_and_send") {
    for (const t of Array.isArray(rest.targets) ? rest.targets : []) if (allowed(t, t.request?.value) && rest.fields && typeof t.id === "string") delete rest.fields[t.id];
  }
  for (const key of PREPARED[tool] ?? []) delete rest[key];
  const lower = passwords.map((p) => p.toLowerCase());
  return stringsIn(rest).some((text) => {
    const forms = decodings(text);
    const address = looksLikeAddress(text);
    // An address on the password site may hold part of the password in its own host (wordpress.test for wordpress-2026).
    const own = address ? webUrl(text.trim()) : undefined;
    const windowed = own && onSite(own.href) ? decodings(own.href.slice(own.origin.length)) : forms;
    return lower.some((p) => {
      if (p.length < 4) return forms.some((f) => f.trim() === p) || (address && queryValues(text).includes(p));
      if (forms.some((f) => f.includes(p))) return true;
      if (!address || p.length < 6) return false;
      const pieces = Array.from({ length: p.length - 5 }, (_, i) => p.slice(i, i + 6));
      return windowed.some((f) => pieces.some((piece) => f.includes(piece)));
    });
  });
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
  async function beforeRead(tabId: number, run: { signal?: AbortSignal; emit: (event: PassEvent) => void; goal?: string; host?: string }): Promise<void> {
    let scan;
    try {
      scan = await scanTab(browser, tabId);
    } catch (error) {
      await log("handoff.scan-failed", { message: error instanceof Error ? error.message : String(error) });
      return;
    }
    hints.set(tabId, scan.scan.fields);
    const all = scan.walls.filter((w) => !signUp(w, scan.scan.fields));
    // Only on the run's own site: a password from the goal never goes to another host (HP18).
    const walls = goalGivesPassword(run.goal) ? all.filter((w) => !(ANSWERED.has(w.kind) && onRunSite(w.host, run.host))) : all;
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
  // A control whose value foxpass replaced is marked, so foxloop's send check knows it cannot read it (HP17).
  const controls = page.controls.map((c, i) => {
    const value = String(safe.fields?.[i]?.value ?? c.value);
    return value !== c.value ? ({ ...c, value, redacted: true } as Snapshot["controls"][number]) : { ...c, value };
  });
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
