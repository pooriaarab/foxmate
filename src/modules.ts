// The optional modules' tools. Each one is off until the user turns it on
// in Settings; a tool that is off refuses and says so. Page images and
// mail are outside text, so their text goes to the planner as data.
//
// Extension points: foxpay (payments) and foxbridge (outside agents over
// MCP) come later. A payment tool would be a LoopTool with scope "pay" and
// an `amount`, added through createAgent's `extraTools`, so foxgate's spend
// caps and an approval for each payment apply.
import type { LoopTool } from "foxloop";

export interface LookDeps {
  enabled: () => Promise<boolean>;
  /** A description of what the tab shows, from a vision model. */
  look: (tabId: number, signal: AbortSignal) => Promise<{ text: string; tier: string }>;
  tabDomain: (tabId: number) => Promise<string>;
}

/** foxlens: a screenshot of the tab, described by a local vision model. For canvas pages. */
export function lookTool(tabId: () => number, deps: LookDeps): LoopTool {
  return {
    name: "look",
    description: "Take a screenshot of the page and get a description from a vision model. Use it when snapshot finds no controls, for example on a canvas page.",
    parameters: { type: "object", properties: {} },
    scope: "read",
    domain: () => deps.tabDomain(tabId()),
    async run(_args, ctx) {
      if (!(await deps.enabled())) return { ok: false, summary: "Screenshots are off. The user can turn them on in Settings." };
      const seen = await deps.look(tabId(), ctx.signal);
      // A canvas page has no DOM text, so foxpaw's page check calls it empty. The description is the check.
      const ok = seen.text.trim().length > 0;
      return { ok, summary: `A vision model (${seen.tier}) described the screenshot.`, untrusted: seen.text, check: { ok, checks: [{ part: "the vision model described the page", ok, evidence: `${seen.text.trim().length} characters` }] } };
    },
  };
}

export const GOOGLE_DOMAIN = "www.googleapis.com";

export interface GoogleDeps {
  enabled: () => Promise<boolean>;
  /** Each item as foxlink's toPromptText gives it. */
  events: (max: number) => Promise<string[]>;
  messages: (max: number) => Promise<string[]>;
}

/** foxlink: read the user's Google Calendar and Gmail, read-only. */
/** Mail and events are private data, and a goal on a web tab must opt in to read them (G16, G18). */
export function googleTools(deps: GoogleDeps): { tool: LoopTool; domain: string; private: true; optIn: true }[] {
  const reader = (name: string, description: string, what: string, read: (max: number) => Promise<string[]>): LoopTool => ({
    name,
    description,
    parameters: { type: "object", properties: { max: { type: "integer", minimum: 1, maximum: 20 } } },
    scope: "read",
    domain: () => GOOGLE_DOMAIN,
    async run(args) {
      if (!(await deps.enabled())) return { ok: false, summary: "Google is not connected. The user can connect it in Settings." };
      const items = await read(typeof args.max === "number" ? args.max : 5);
      return { ok: true, summary: `Read ${items.length} ${what}.`, untrusted: items.join("\n\n") || `No ${what}.`, check: { ok: true, checks: [{ part: `read ${what}`, ok: true, evidence: String(items.length) }] } };
    },
  });
  return [
    { tool: reader("read_calendar", "List the next events in the user's Google Calendar.", "calendar events", deps.events), domain: GOOGLE_DOMAIN, private: true, optIn: true },
    { tool: reader("read_inbox", "List the newest messages in the user's Gmail inbox.", "messages", deps.messages), domain: GOOGLE_DOMAIN, private: true, optIn: true },
  ];
}
