// The shield: a foxpaw wrapper for foxloop's browser tools. Each snapshot
// runs foxshield's scanDocument in the tab, and the planner gets sanitize()
// output in place of the raw page text. When the scan fails, the page text
// is withheld (docs/failure-modes.md S1-S7).
import type { PawLike } from "foxloop";
import * as foxpaw from "foxpaw";
import type { Control, ScriptingApi, Snapshot } from "foxpaw";
import { sanitize, scanDocument, type FindingKind, type ScanReport } from "foxshield";

/** What foxshield did to one page, for the trail. */
export interface ShieldScan {
  url: string;
  findings: number;
  top: { kind: FindingKind; reason: string; score: number; text: string }[];
  droppedControls: string[];
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
}

const HIDDEN: ReadonlySet<FindingKind> = new Set(["display-none", "not-rendered", "visibility-hidden", "opacity-zero", "offscreen", "clipped", "tiny-font", "low-contrast", "aria-hidden", "covered"]);
const MAX_TEXT = 6000;
const LOAD_WAIT_MS = 10_000;
const WITHHELD = "[foxshield could not scan this page, so foxmate withheld its text.]";

/**
 * Runs in the page. The foxpaw nodes that sit inside an element that a
 * selector matches. Self-contained, for scripting.executeScript.
 */
export function hiddenNodes(selectors: string[], nodes: number[]): number[] {
  // oxlint-disable-next-line no-underscore-dangle -- foxpaw keeps its node map at window.__foxpaw.
  const cache = (window as unknown as { __foxpaw?: { nodes: Map<number, Element> } }).__foxpaw;
  if (!cache) throw new Error("foxpaw has not read this page.");
  const boxes: Element[] = [];
  for (const selector of selectors) {
    try {
      boxes.push(...document.querySelectorAll(selector));
    } catch {
      // A selector that this document cannot parse matches nothing.
    }
  }
  return nodes.filter((node) => {
    const element = cache.nodes.get(node);
    return Boolean(element && boxes.some((box) => box === element || box.contains(element)));
  });
}
const cut = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

async function scan(options: ShieldOptions, tabId: number): Promise<ScanReport> {
  const results = await options.browser.scripting.executeScript({ target: { tabId }, func: scanDocument, args: [{}] });
  const report = Array.isArray(results) ? (results[0] as { result?: ScanReport } | undefined)?.result : undefined;
  if (!report || !Array.isArray(report.blocks) || !Array.isArray(report.findings)) throw new Error("The scan gave no report.");
  return report;
}

/** foxpaw, with every snapshot's text passed through foxshield. */
export function shieldedPaw(options: ShieldOptions): PawLike {
  const paw = options.paw ?? foxpaw;
  return {
    act: paw.act,
    settle: paw.settle,
    runTask: paw.runTask,
    async snapshot(tabId: number, browser?: ScriptingApi): Promise<Snapshot> {
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
        await options.onScan?.({ url: page.url, findings: 0, top: [], droppedControls: [], withheld: why });
        return { ...page, text: WITHHELD };
      }
      const threshold = options.threshold ?? 0.5;
      // Ask the page which controls sit inside an element that foxshield found hidden. A word
      // match is not enough: trap text often names real fields, such as "password".
      const selectors = report.findings.filter((f) => HIDDEN.has(f.kind) && !f.selector.includes(">>>")).map((f) => f.selector);
      let hiddenSet = new Set<number>();
      if (selectors.length) {
        try {
          const results = await options.browser.scripting.executeScript({ target: { tabId, frameIds: [0] }, func: hiddenNodes, args: [selectors, page.controls.filter((c) => c.frameId === 0).map((c) => c.node)] });
          const nodes = Array.isArray(results) ? (results[0] as { result?: unknown } | undefined)?.result : undefined;
          if (!Array.isArray(nodes)) throw new Error("The page gave no answer.");
          hiddenSet = new Set(nodes as number[]);
        } catch (error) {
          const why = error instanceof Error ? error.message : String(error);
          await options.onScan?.({ url: page.url, findings: report.findings.length, top: [], droppedControls: [], withheld: why });
          return { ...page, text: WITHHELD };
        }
      }
      const inHidden = (c: Control) => c.frameId === 0 && hiddenSet.has(c.node);
      const controls = page.controls.filter((c) => !inHidden(c));
      const dropped = page.controls.filter(inHidden).map((c) => c.label);
      await options.onScan?.({
        url: page.url,
        findings: report.findings.length,
        top: report.findings.slice(0, 5).map((f) => ({ kind: f.kind, reason: f.reason, score: f.score, text: cut(f.text, 120) })),
        droppedControls: dropped,
      });
      return { ...page, controls, text: cut(sanitize(report, { threshold }), MAX_TEXT) };
    },
  };
}
