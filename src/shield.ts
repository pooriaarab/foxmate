// The shield: a foxpaw wrapper for foxloop's browser tools. Each snapshot
// runs foxshield's scanDocument in the tab, and the planner gets sanitize()
// output in place of the raw page text. When the scan fails, the page text
// is withheld (docs/failure-modes.md S1-S7). A control written in the text
// of a flagged block is dropped like one in hidden text (S20). runTask reads each page through
// the same scan (S13). Last, foxpass's redaction takes typed secrets out of
// the page the planner reads and out of the quotes (HP5, HP6, S14).
import type { PawLike } from "foxloop";
import * as foxpaw from "foxpaw";
import { parseGoal } from "foxpaw";
import type { Control, ScriptingApi, Snapshot } from "foxpaw";
import type { FieldInfo } from "foxpass";
import { sanitize, scanDocument, type FindingKind, type ScanReport } from "foxshield";
import { redactPage } from "./pass.js";

/** What foxshield did to one page, for the trail. */
export interface ShieldScan {
  url: string;
  findings: number;
  top: { kind: FindingKind; reason: string; score: number; text: string }[];
  droppedControls: string[];
  /** Blocks at or above the threshold, which sanitize() wraps as untrusted data (G49). */
  flagged: number;
  /** Why the page text was withheld, when it was. */
  withheld?: string;
}

export interface ShieldOptions {
  /** `browser.scripting`, to run the scan in the tab. */
  browser: { scripting: { executeScript(details: unknown): Promise<unknown> }; tabs?: { get(tabId: number): Promise<{ status?: string }> } };
  paw?: PawLike;
  /** sanitize() wraps blocks at or above this score. Default 0.5. */
  threshold?: number;
  onScan?: (scan: ShieldScan) => void | Promise<void>;
  /** foxpass's newest scan of the tab, so the redaction knows which fields hold secrets. */
  fieldHints?: (tabId: number) => FieldInfo[];
  /**
   * Runs before each read, the snapshot and each read inside runTask: foxpass's
   * sign-in wait (HP10-HP13). It throws when the user does not finish.
   */
  beforeRead?: (tabId: number) => Promise<void>;
}

const HIDDEN: ReadonlySet<FindingKind> = new Set(["display-none", "not-rendered", "visibility-hidden", "opacity-zero", "offscreen", "clipped", "tiny-font", "low-contrast", "aria-hidden", "covered"]);
const MAX_TEXT = 6000;
const LOAD_WAIT_MS = 10_000;
const WITHHELD = "[foxshield could not scan this page, so foxmate withheld its text.]";

/**
 * Runs in the page. The foxpaw nodes that sit inside an element that a
 * selector matches. For an `offscreen` finding the control's own box decides:
 * a box on the page stays, as an icon button whose word text-indent moves out
 * (S15). Self-contained, for scripting.executeScript.
 */
export function hiddenNodes(findings: { selector: string; kind: string }[], nodes: number[]): number[] {
  // oxlint-disable-next-line no-underscore-dangle -- foxpaw keeps its node map at window.__foxpaw.
  const cache = (window as unknown as { __foxpaw?: { nodes: Map<number, Element> } }).__foxpaw;
  if (!cache) throw new Error("foxpaw has not read this page.");
  const boxes: { box: Element; moved: boolean }[] = [];
  for (const { selector, kind } of findings) {
    try {
      for (const box of document.querySelectorAll(selector)) boxes.push({ box, moved: kind === "offscreen" });
    } catch {
      // A selector that this document cannot parse matches nothing.
    }
  }
  // foxshield's own test for off the page: left of or above it, or 5000 px or more to the right.
  // oxlint-disable-next-line unicorn/consistent-function-scoping -- the page runs this function alone, so it keeps its helpers inside.
  const offPage = (element: Element) => {
    const r = element.getBoundingClientRect();
    return r.right + window.scrollX <= 0 || r.bottom + window.scrollY <= 0 || r.left + window.scrollX >= 5000;
  };
  return nodes.filter((node) => {
    const element = cache.nodes.get(node);
    return Boolean(element && boxes.some(({ box, moved }) => (box === element || box.contains(element)) && (!moved || offPage(element))));
  });
}
/**
 * Runs in the page. The foxpaw nodes written in the text of a flagged block:
 * the nearest block element above the control is one that a selector matches
 * (S20). A control in a nested block, a form or a `p`, stays (S21). The tags
 * are foxshield's block tags, less the ones that wrap a control (a label, a
 * button, a select): they do not part a field from the notice around it.
 * Self-contained, for scripting.executeScript.
 */
export function noticeNodes(selectors: string[], nodes: number[]): number[] {
  // oxlint-disable-next-line no-underscore-dangle -- foxpaw keeps its node map at window.__foxpaw.
  const cache = (window as unknown as { __foxpaw?: { nodes: Map<number, Element> } }).__foxpaw;
  if (!cache) throw new Error("foxpaw has not read this page.");
  const block = new Set(["address", "article", "aside", "blockquote", "body", "caption", "dd", "details", "dialog", "div", "dl", "dt", "fieldset",
    "figcaption", "figure", "footer", "form", "h1", "h2", "h3", "h4", "h5", "h6", "header", "html", "legend", "li", "main", "nav", "ol", "p", "pre",
    "section", "summary", "table", "tbody", "td", "tfoot", "th", "thead", "tr", "ul"]);
  const flagged = new Set<Element>();
  for (const selector of selectors) {
    try {
      for (const box of document.querySelectorAll(selector)) flagged.add(box);
    } catch {
      // A selector that this document cannot parse matches nothing.
    }
  }
  return nodes.filter((node) => {
    let up = cache.nodes.get(node)?.parentElement;
    while (up && !block.has(up.localName)) up = up.parentElement;
    return Boolean(up && flagged.has(up));
  });
}
const cut = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

async function scan(options: ShieldOptions, tabId: number): Promise<ScanReport> {
  const results = await options.browser.scripting.executeScript({ target: { tabId }, func: scanDocument, args: [{}] });
  const report = Array.isArray(results) ? (results[0] as { result?: ScanReport } | undefined)?.result : undefined;
  if (!report || !Array.isArray(report.blocks) || !Array.isArray(report.findings)) throw new Error("The scan gave no report.");
  return report;
}

/** A page as the shield sees it, before foxpass's redaction, with what foxshield did. */
/** `flagged`: the text of each block that sanitize() wraps as instructions to an agent (S16). */
interface ShieldRead { page: Snapshot; seen: ShieldScan; flagged?: string[] }

/**
 * A value as S16 compares it, the same on both sides: NFKC, no invisible or
 * format characters (Unicode Cf: zero-width, soft hyphen, bidi marks), no
 * character that is not a letter or a digit, lower case. foxshield's tidy()
 * removes zero-width characters from the text the planner reads, so a raw
 * compare missed a value split by one (S16).
 */
export const squash = (text: string) => text.normalize("NFKC").replace(/\p{Cf}/gu, "").replace(/[^\p{L}\p{N}]+/gu, "").toLowerCase();
/** A value that names something (an IBAN, an account, an address, a link): 6 or more characters with 4 digits, an @ or a web address (S16). */
const NAMES = (value: string) => {
  const plain = value.normalize("NFKC").replace(/\p{Cf}/gu, "");
  return squash(plain).length >= 6 && (/(?:\d\D*){4}/.test(plain) || plain.includes("@") || /:\/\/|www/i.test(plain));
};
const FLAGGED = "The value comes from page text that foxshield flagged as instructions to an AI agent, and the goal does not name it, so foxmate does not type it.";
const FLAGGED_TASK = "The task holds a value that comes from page text that foxshield flagged as instructions to an AI agent, and the goal does not name it, so foxmate does not run it.";
/** The flagged text a run keeps: one entry per distinct squashed text (S17). Past the cap, every value that names something and that the goal does not name is refused. */
const MAX_FLAGGED = 500;
/** A table cell block: a cell next to a flagged cell is the row's own data, not the rest of a split attack (S18). */
const CELL = /> (?:td|th):nth-of-type\(\d+\)$/;
/**
 * A block that is only a value, with at most a short label ("IBAN: US13 3000 ...", "x@evil.test"):
 * each word holds a digit, an @ or a web address. A sentence ("Questions? Call 0800 123 456.") is not (S18).
 */
const bare = (text: string) => {
  const words = text.normalize("NFKC").replace(/\p{Cf}/gu, "").replace(/^[^:\n]{1,24}:/, "").trim().split(/\s+/).filter(Boolean);
  return words.length > 0 && words.every((w) => /[\d@]|:\/\/|^www\./i.test(w));
};
/** The values in a browser_task goal that foxpaw can type: each requirement value, and each email, web address or run of digit words (S19). */
const goalValues = (goal: string): string[] => {
  const plain = goal.normalize("NFKC").replace(/\p{Cf}/gu, "");
  const spans = [/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, /(?:https?:\/\/|www\.)\S+/gi, /[\p{L}\p{N}]*\p{N}[\p{L}\p{N}]*(?:[\s./\\_-]+[\p{L}\p{N}]*\p{N}[\p{L}\p{N}]*)*/gu];
  return [...parseGoal(plain).requirements.flatMap((r) => (r.value ? [r.value] : [])), ...spans.flatMap((re) => plain.match(re) ?? [])];
};

/** foxpaw through foxshield, with `newRun`: each run starts with no flagged text and its own goal (S16). */
export type ShieldedPaw = PawLike & { newRun(goal: string): void };

/**
 * The shield-only read: wait for the load (S11), read, scan, drop the controls
 * inside hidden elements (S5), and sanitize the text or withhold it (S3, S4, S10).
 */
async function shieldRead(options: ShieldOptions, paw: PawLike, tabId: number, browser?: ScriptingApi): Promise<ShieldRead> {
  // A click on a link starts a navigation; reading before it ends sees the old page or an empty one (S11).
  for (let waited = 0; options.browser.tabs && waited < LOAD_WAIT_MS; waited += 100) {
    if ((await options.browser.tabs.get(tabId).catch(() => ({ status: "complete" }))).status === "complete") break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const page = await paw.snapshot(tabId, browser);
  let report: ScanReport;
  try {
    report = await scan(options, tabId);
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error);
    return { page: { ...page, text: WITHHELD }, seen: { url: page.url, findings: 0, top: [], droppedControls: [], flagged: 0, withheld: why } };
  }
  const threshold = options.threshold ?? 0.5;
  // Ask the page which controls sit inside an element that foxshield found hidden. A word
  // match is not enough: trap text often names real fields, such as "password".
  const selectors = report.findings.filter((f) => HIDDEN.has(f.kind) && !f.selector.includes(">>>")).map((f) => ({ selector: f.selector, kind: f.kind }));
  let hiddenSet = new Set<number>();
  if (selectors.length) {
    try {
      const results = await options.browser.scripting.executeScript({ target: { tabId, frameIds: [0] }, func: hiddenNodes, args: [selectors, page.controls.filter((c) => c.frameId === 0).map((c) => c.node)] });
      const nodes = Array.isArray(results) ? (results[0] as { result?: unknown } | undefined)?.result : undefined;
      if (!Array.isArray(nodes)) throw new Error("The page gave no answer.");
      hiddenSet = new Set(nodes as number[]);
    } catch (error) {
      const why = error instanceof Error ? error.message : String(error);
      return { page: { ...page, text: WITHHELD }, seen: { url: page.url, findings: report.findings.length, top: [], droppedControls: [], flagged: 0, withheld: why } };
    }
  }
  // A control written in a flagged block: a link in a note to AI assistants is never offered to the planner (S20).
  const notices = report.blocks.filter((b) => (b.score ?? 0) >= threshold && !b.selector.includes(">>>")).map((b) => b.selector);
  if (notices.length) {
    try {
      const results = await options.browser.scripting.executeScript({ target: { tabId, frameIds: [0] }, func: noticeNodes, args: [notices, page.controls.filter((c) => c.frameId === 0).map((c) => c.node)] });
      const nodes = Array.isArray(results) ? (results[0] as { result?: unknown } | undefined)?.result : undefined;
      if (!Array.isArray(nodes)) throw new Error("The page gave no answer.");
      hiddenSet = new Set([...hiddenSet, ...(nodes as number[])]);
    } catch (error) {
      const why = error instanceof Error ? error.message : String(error);
      return { page: { ...page, text: WITHHELD }, seen: { url: page.url, findings: report.findings.length, top: [], droppedControls: [], flagged: 0, withheld: why } };
    }
  }
  const inHidden = (c: Control) => c.frameId === 0 && hiddenSet.has(c.node);
  return {
    page: { ...page, controls: page.controls.filter((c) => !inHidden(c)), text: cut(sanitize(report, { threshold }), MAX_TEXT) },
    // A flagged block, and a block next to it that is only a value and not a table cell: an attack
    // can put its instruction in one block and its value alone in the next (S18).
    flagged: report.blocks.filter((b, i, all) => (b.score ?? 0) >= threshold || (!CELL.test(b.selector) && bare(b.text) && [all[i - 1], all[i + 1]].some((n) => (n?.score ?? 0) >= threshold))).map((b) => squash(b.text)),
    seen: {
      url: page.url,
      findings: report.findings.length,
      top: report.findings.slice(0, 5).map((f) => ({ kind: f.kind, reason: f.reason, score: f.score, text: f.text })),
      droppedControls: page.controls.filter(inHidden).map((c) => c.label),
      flagged: report.blocks.filter((b) => (b.score ?? 0) >= threshold).length,
    },
  };
}

/**
 * foxpaw, with every page read passed through foxshield: each snapshot, and
 * each read inside runTask (S13). Each read waits on `beforeRead` first (HP10). Only the snapshot, which the planner reads,
 * also gets foxpass's redaction; runTask needs the real field values (S14).
 */
export function shieldedPaw(options: ShieldOptions): ShieldedPaw {
  const paw = options.paw ?? foxpaw;
  // The flagged text that this run read, and its goal, both squashed (S16). A Set: a page read
  // again adds nothing, so repeated reads cannot fill the cap before an attack value (S17).
  let flagged = new Set<string>();
  let overflow = false;
  let runGoal = "";
  const remember = (read: ShieldRead) => {
    for (const text of read.flagged ?? []) {
      if (flagged.has(text)) continue;
      if (flagged.size >= MAX_FLAGGED) overflow = true;
      else flagged.add(text);
    }
  };
  /** A value that only flagged text of this run holds, and the goal does not (S16-S19). */
  const refuses = (raw: string) => {
    const value = squash(raw);
    if (!NAMES(raw) || runGoal.includes(value)) return false;
    return overflow || [...flagged].some((text) => text.includes(value));
  };
  /** Redacts the page with foxpass. The quotes for the trail are always redacted. */
  const redact = async (tabId: number, { page, seen }: ShieldRead): Promise<Snapshot> => {
    const safe = redactPage(page, options.fieldHints?.(tabId) ?? [], seen.top.map((t) => t.text));
    await options.onScan?.({ ...seen, top: seen.top.map((t, i) => ({ ...t, text: cut(safe.quotes[i] ?? "", 120) })) });
    return { ...safe.page, text: cut(safe.page.text, MAX_TEXT) };
  };
  return {
    newRun: (text: string) => {
      flagged = new Set();
      overflow = false;
      runGoal = squash(text);
    },
    // A value that only flagged text holds is refused before it reaches the page (S16).
    act: async (tabId, control, request, page, browser) => {
      if (refuses(request.value ?? "")) return { ok: false, reason: "unsupported", detail: FLAGGED };
      return paw.act(tabId, control, request, page, browser);
    },
    settle: paw.settle,
    runTask: async (tabId, goal, runOptions) => {
      // foxpaw retries a read that throws for 10 s: a failed wait fails each retry at once, with no new wait (HP12).
      let failed: unknown;
      // browser_task types the values of its goal with foxpaw's own act, past the S16 check above.
      // Each read checks them: a refused one gives a page with no controls, so nothing is acted on (S19).
      let refused = false;
      const result = await paw.runTask(tabId, goal, {
        ...runOptions,
        read: async (readTabId, browser) => {
          if (failed) throw failed;
          try {
            await options.beforeRead?.(readTabId);
          } catch (error) {
            // Stop: give the shielded page, and foxpaw sees the abort before it acts (HP12).
            if (!runOptions?.signal?.aborted) throw (failed = error);
          }
          const read = await shieldRead(options, paw, readTabId, browser);
          remember(read);
          await redact(readTabId, read);
          if (refused || goalValues(goal).some(refuses)) {
            refused = true;
            return { ...read.page, controls: [], text: FLAGGED_TASK };
          }
          return read.page;
        },
      });
      return refused ? { ...result, status: "blocked", blockedReason: FLAGGED_TASK, verified: false } : result;
    },
    // A pure function of a snapshot that came through this shield: foxloop's browser_task preview (UI10).
    preview: paw.preview,
    // Pure text formats: foxloop gives them only snapshots that came through this shield (S12).
    pageText: paw.pageText,
    changeText: paw.changeText,
    snapshot: async (tabId: number, browser?: ScriptingApi): Promise<Snapshot> => {
      await options.beforeRead?.(tabId);
      const read = await shieldRead(options, paw, tabId, browser);
      remember(read);
      return redact(tabId, read);
    },
  };
}
