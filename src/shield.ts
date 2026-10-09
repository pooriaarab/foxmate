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
  browser: { scripting: { executeScript(details: unknown): Promise<unknown> } };
  paw?: PawLike;
  /** sanitize() wraps blocks at or above this score. Default 0.5. */
  threshold?: number;
  onScan?: (scan: ShieldScan) => void | Promise<void>;
}

const HIDDEN: ReadonlySet<FindingKind> = new Set(["display-none", "not-rendered", "visibility-hidden", "opacity-zero", "offscreen", "clipped", "tiny-font", "low-contrast", "aria-hidden", "covered"]);
const MAX_TEXT = 6000;
const norm = (text: string): string => text.replace(/\s+/g, " ").trim().toLowerCase();
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
      const page = await paw.snapshot(tabId, browser);
      let report: ScanReport;
      try {
        report = await scan(options, tabId);
      } catch (error) {
        const why = error instanceof Error ? error.message : String(error);
        await options.onScan?.({ url: page.url, findings: 0, top: [], droppedControls: [], withheld: why });
        return { ...page, text: "[foxshield could not scan this page, so foxmate withheld its text.]" };
      }
      const threshold = options.threshold ?? 0.5;
      // Flagged hidden text drops any control in it. Low-score hidden text (the options of a
      // closed <select>) drops only an off-screen control, so a visible field stays.
      const hidden = report.findings.filter((f) => HIDDEN.has(f.kind));
      const inHidden = (c: Control) => {
        const label = norm(c.label);
        return label.length >= 4 && hidden.some((f) => (f.score >= threshold || c.offscreen) && norm(f.text).includes(label));
      };
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
