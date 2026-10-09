// The agent: one goal on one tab, with every part wired in. Memory notes go
// into the goal, the brain picks the planner, foxloop plans and calls tools
// through foxgate, page text passes foxshield, approvals come from a human,
// and foxtrail records each step (docs/failure-modes.md G1-G10).
import { createFoxgate, type Gate, type Host, type PublicSuffix, type Scope } from "foxgate";
import { browserTools, createLoop, toolSpecs, type CheckResult, type LoopEvent, type LoopTool, type ToolContext } from "foxloop";
import type { FoxMemory } from "foxmemory";
import * as foxpaw from "foxpaw";
import type { ScriptingApi, Snapshot } from "foxpaw";
import type { Provider } from "foxmind";
import { createApprovals, type Approvals } from "./approvals.js";
import { formDetail } from "./form.js";
import { BrainError, createBrain, type BrainSettings } from "./brain.js";
import { recallNotes, withNotes } from "./recall.js";
import { shieldedPaw } from "./shield.js";

export interface Trail {
  append(entry: { actor: string; kind: string; data?: unknown }): Promise<unknown>;
}

export interface AgentBrowser {
  tabs: { get(tabId: number): Promise<{ id?: number; url?: string; cookieStoreId?: string }> };
  permissions?: { contains(permissions: unknown): Promise<boolean> };
  scripting?: { executeScript(details: unknown): Promise<unknown> };
}

export interface Loan {
  cookieStoreId: string;
  scope: Scope;
}

export interface RunInput {
  goal: string;
  tabId: number;
  settings: BrainSettings;
  /** Run in a lent tab: the tab must be in the loan's container. */
  loan?: Loan;
  signal?: AbortSignal;
  onEvent?: (event: AgentEvent) => void;
}

export type AgentEvent =
  | (LoopEvent & { exactText?: string })
  | { type: "start"; planner: string; privacy: string; goal: string }
  | { type: "recall"; notes: string[]; error?: string }
  | { type: "refused"; reason: string; message: string };

export interface RunEnd {
  status: "done" | "blocked" | "aborted" | "refused";
  summary?: string;
  reason?: string;
  message?: string;
}

export interface AgentOptions {
  browser: AgentBrowser;
  trail: Trail;
  memory?: Pick<FoxMemory, "recall">;
  publicSuffix?: PublicSuffix;
  /** The tools for a tab. Default: foxloop's browser tools over foxshield. */
  makeTools?: (tabId: () => number) => LoopTool[];
  /** The active loan whose container holds this cookie store, if any. A run on that tab is a loan run (G12). */
  loanFor?: (cookieStoreId: string) => Promise<Loan | undefined>;
  /** More tools on the run's tab, for example a screenshot tool. The tab's grants cover them. */
  moreTabTools?: (tabId: () => number) => LoopTool[];
  /** More tools, for example the Space. Each one names its own domain. */
  extraTools?: { tool: LoopTool; domain: string }[];
  /** Why the page is not a good end page, or undefined. Default: foxpaw's problemOf. */
  pageProblem?: (tabId: number) => Promise<string | undefined>;
  browserModel?: () => Promise<Provider>;
  maxSteps?: number;
  /** The time budget of a run, and the life of its grants. Default 10 minutes. */
  runMs?: number;
}

export interface Agent {
  gate: Gate;
  host: Host;
  approvals: Approvals;
  readonly busy: boolean;
  run(input: RunInput): Promise<RunEnd>;
}

const SCOPES: Scope[] = ["read", "fill", "submit"];

export function createAgent(options: AgentOptions): Agent {
  const { browser, trail } = options;
  let target = 0;
  let busy = false;
  // The newest snapshot the planner got, for the form detail of an approval.
  let lastPage: Snapshot | undefined;
  const shielded = shieldedPaw({ browser: browser as never, onScan: async (scan) => { await trail.append({ actor: "foxshield", kind: "shield.scan", data: scan }); } });
  const paw = { ...shielded, snapshot: async (tabId: number, api?: ScriptingApi) => (lastPage = await shielded.snapshot(tabId, api)) };
  const tabTools = [...(options.makeTools?.(() => target) ?? browserTools({ tabId: () => target, browser: browser as never, paw })), ...(options.moreTabTools?.(() => target) ?? [])]
    .map((tool) => (tool.name !== "click" ? tool : {
      ...tool,
      describe: async (args: Record<string, unknown>, ctx: ToolContext) => [await tool.describe?.(args, ctx), formDetail(lastPage, String(args.controlId))].filter(Boolean).join(" "),
    }));
  const extra = options.extraTools ?? [];
  const tools = [...tabTools, ...extra.map((e) => e.tool)];
  const { gate, host } = createFoxgate({ tools: toolSpecs(tools), ...(options.publicSuffix ? { publicSuffix: options.publicSuffix } : {}) });
  const approvals = createApprovals({ host, trail });
  const runMs = options.runMs ?? 10 * 60_000;
  const pageProblem = options.pageProblem ?? (async (tabId: number) => foxpaw.problemOf(await foxpaw.snapshot(tabId, browser as never)));

  // Good tool results in the current run (one run at a time).
  let worked = 0;
  // When the newest result has no check, a tool must have worked in this run (G15), and
  // the page must show no error page to foxpaw (G10).
  const check = async ({ lastCheck }: { lastCheck?: CheckResult }): Promise<CheckResult> => {
    if (lastCheck) return lastCheck;
    if (!worked) return { ok: false, checks: [{ part: "a tool ran with a good result", ok: false, evidence: "no tool ran" }], problem: "nothing was done" };
    const problem = await pageProblem(target).catch((error: unknown) => `foxmate could not read the page: ${String(error)}`);
    return { ok: !problem, checks: [{ part: "the page shows no error (no task check)", ok: !problem, evidence: problem ?? "no error page" }], ...(problem ? { problem } : {}) };
  };

  async function run(input: RunInput): Promise<RunEnd> {
    const emit = (event: AgentEvent) => input.onEvent?.(event);
    const refuse = async (reason: string, message: string): Promise<RunEnd> => {
      emit({ type: "refused", reason, message });
      await trail.append({ actor: "foxmate", kind: "run.refused", data: { reason, message } });
      return { status: "refused", reason, message };
    };
    if (busy) return { status: "refused", reason: "busy", message: "A run is in progress." };
    busy = true;
    const grants: string[] = [];
    try {
      const tab = await browser.tabs.get(input.tabId);
      // A tab with no web page gets no tab grants. The extra tools, such as the Space, still work.
      let domain: string | undefined;
      try {
        const url = new URL(tab.url ?? "");
        if (url.protocol === "http:" || url.protocol === "https:") domain = url.hostname;
      } catch {
        domain = undefined;
      }
      if (!domain && !extra.length) return await refuse("no-page", "The tab shows no web page.");
      if (input.loan && tab.cookieStoreId !== input.loan.cookieStoreId) return await refuse("loan-mismatch", "The tab is not in the lent container.");
      // A goal from Chat on a lent tab names no loan, but it is a loan run all the same.
      const loan = input.loan ?? (tab.cookieStoreId ? await options.loanFor?.(tab.cookieStoreId) : undefined);
      await trail.append({ actor: "user", kind: "run.start", data: { goal: input.goal, domain: domain ?? null, planner: input.settings.planner ?? "saluki", loan: Boolean(loan) } });
      const recalled = options.memory ? await recallNotes(options.memory, input.goal) : { notes: [] };
      emit({ type: "recall", ...recalled });
      const goal = withNotes(input.goal, recalled.notes);
      let brain;
      try {
        brain = await createBrain(input.settings, {
          hasDataConsent: async () => (await browser.permissions?.contains({ data_collection: ["websiteContent"] })) ?? false,
          goal,
          ...(options.browserModel ? { browserModel: options.browserModel } : {}),
        });
      } catch (error) {
        if (error instanceof BrainError) return await refuse(error.code, error.message);
        throw error;
      }
      emit({ type: "start", planner: brain.planner, privacy: brain.privacy, goal });
      target = input.tabId;
      const expiresAt = Date.now() + runMs;
      const scopes = loan ? SCOPES.slice(0, SCOPES.indexOf(loan.scope) + 1) : SCOPES;
      if (domain) for (const scope of scopes) grants.push((await host.addGrant({ scope, domains: [domain], expiresAt })).id);
      for (const { tool, domain: own } of extra.filter((e) => scopes.includes(e.tool.scope))) grants.push((await host.addGrant({ scope: tool.scope, domains: [own], tools: [tool.name], expiresAt })).id);
      const loop = createLoop({ mind: brain.mind, gate, tools, trail, check, maxSteps: options.maxSteps ?? 20, budget: { ms: runMs }, onApproval: (request) => approvals.ask(request) });
      let end: RunEnd = { status: "aborted" };
      worked = 0;
      for await (const event of loop.run(goal, input.signal ? { signal: input.signal } : {})) {
        if (event.type === "approval-needed") {
          approvals.expect(event.requestId);
          // ask() reads foxgate's text when foxloop calls it; read it here too, for the event.
          const text = (await host.pending()).find((r) => r.id === event.requestId)?.text;
          emit({ ...event, ...(text ? { exactText: text } : {}) });
        } else emit(event);
        if (event.type === "tool-result" && event.ok) worked += 1;
        if (event.type === "done") end = { status: "done", summary: event.summary };
        if (event.type === "blocked") end = { status: "blocked", reason: event.reason, message: event.message };
      }
      return end;
    } finally {
      approvals.cancelAll();
      for (const id of grants) await host.revokeGrant(id).catch(() => undefined);
      busy = false;
      await trail.append({ actor: "foxmate", kind: "run.end", data: {} }).catch(() => undefined);
    }
  }

  return { gate, host, approvals, get busy() { return busy; }, run };
}
