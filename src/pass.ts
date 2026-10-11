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

export class HandoffError extends Error {}

/** foxpass's browser. The stand-in reads the tab address, so foxpass scans the top frame of the tab (HP8). */
function handoffBrowser(browser: PassBrowser): HandoffBrowser {
  const getFrame = async ({ tabId }: { tabId: number }) => ({ url: (await browser.tabs.get(tabId)).url ?? "" });
  return { tabs: browser.tabs, windows: browser.windows, scripting: browser.scripting, webNavigation: { getFrame }, ...(browser.cookies ? { cookies: browser.cookies } : {}) };
}

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
  async function beforeRead(tabId: number, run: { signal?: AbortSignal; emit: (event: PassEvent) => void }): Promise<void> {
    let scan;
    try {
      scan = await scanTab(browser, tabId);
    } catch (error) {
      await log("handoff.scan-failed", { message: error instanceof Error ? error.message : String(error) });
      return;
    }
    hints.set(tabId, scan.scan.fields);
    const walls = scan.walls.filter((w) => !signUp(w, scan.scan.fields));
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
    if (result.status !== "signed-in" && result.status !== "no-wall") throw new HandoffError(`The user did not finish the sign-in step (${result.status}). Stop, and tell the user.`);
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
