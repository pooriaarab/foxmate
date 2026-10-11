// The agent: one goal on one tab, with every part wired in. Memory notes go
// into the goal, the brain picks the planner, foxloop plans and calls tools
// through foxgate, page text passes foxshield, approvals come from a human,
// and foxtrail records each step (docs/failure-modes.md G1-G10).
import { createFoxgate, type Gate, type Host, type PublicSuffix, type Scope } from "foxgate";
import { browserTools, createLoop, toolSpecs, type CheckResult, type LoopEvent, type LoopTool, type MindLike, type ToolContext } from "foxloop";
import { GATE_CURRENCY, PAY_TOOL, createFoxpay, payTools, type Foxpay } from "foxpay-agent";
import type { FoxMemory } from "foxmemory";
import * as foxpaw from "foxpaw";
import type { ScriptingApi, Snapshot } from "foxpaw";
import type { Provider } from "foxmind";
import { createApprovals, type Approvals } from "./approvals.js";
import { formDetail } from "./form.js";
import { BrainError, createBrain, type BrainSettings } from "./brain.js";
import type { Pass, PassEvent } from "./pass.js";
import { payTool, type PayOptions, type PayRun } from "./pay.js";
import { recallNotes, withNotes } from "./recall.js";
import { shieldedPaw } from "./shield.js";

export interface Trail {
  append(entry: { actor: string; kind: string; data?: unknown }): Promise<unknown>;
}

export interface AgentBrowser {
  tabs: { get(tabId: number): Promise<{ id?: number; url?: string; cookieStoreId?: string }> };
  scripting?: { executeScript(details: unknown): Promise<unknown> };
}

export interface Loan {
  cookieStoreId: string;
  scope: Scope;
  /** The lent host and its registrable site. A loan run stays on them (G20). */
  domain?: string;
  site?: string;
  /** foxlend's state. A loan that is not active refuses the run (G19). */
  state?: string;
}

export interface RunInput {
  goal: string;
  tabId: number;
  settings: BrainSettings;
  /** Run in a lent tab: the tab must be in the loan's container. */
  loan?: Loan;
  /** The user lets this goal read private data (mail, calendar) on a web tab (G18). */
  allowPrivate?: boolean;
  /** The same for each attempt of one task (the foxrunner task id). A payment uses it against replays (PY5). */
  runKey?: string;
  /** A planner from outside, for example one call from foxbridge. It skips the brain and memory (BR5). */
  mind?: MindLike;
  signal?: AbortSignal;
  onEvent?: (event: AgentEvent) => void;
}

export type AgentEvent =
  | (LoopEvent & { exactText?: string })
  | { type: "start"; planner: string; goal: string }
  | { type: "recall"; notes: string[]; error?: string }
  | { type: "refused"; reason: string; message: string }
  | { type: "private"; source: string }
  | PassEvent;

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
  /**
   * More tools, for example the Space. Each one names its own domain.
   * `private`: its good result is private data (G16). `optIn`: granted on a
   * web tab only when the goal sets `allowPrivate` (G18).
   */
  extraTools?: { tool: LoopTool; domain: string; private?: boolean; optIn?: boolean }[];
  /** Why the page is not a good end page, or undefined. Default: foxpaw's problemOf. */
  pageProblem?: (tabId: number) => Promise<string | undefined>;
  browserModel?: () => Promise<Provider>;
  /** Payments through foxpay, on the tab's host, with a cap and an approval for each one (PY1-PY12). */
  pay?: PayOptions;
  /** The sign-in handoff: a wall makes each page read wait for the user (HP1-HP9). */
  pass?: Pass;
  /**
   * Runs on each message to the planner before it goes out, for example the
   * login vault's redact, so a saved password shows its handle (LV1).
   */
  redact?: (text: string) => Promise<string>;
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
const noEvent = () => undefined;

export function createAgent(options: AgentOptions): Agent {
  const { browser, trail } = options;
  let target = 0;
  let busy = false;
  // The newest snapshot the planner got, and the control it typed into last, for the form detail of an approval.
  let lastPage: Snapshot | undefined;
  let lastTyped: string | undefined;
  // The current run's events and Stop, for a sign-in wait inside a page read.
  let runEmit: (event: AgentEvent) => void = noEvent;
  let runSignal: AbortSignal | undefined;
  const shielded = shieldedPaw({ browser: browser as never, onScan: async (scan) => { await trail.append({ actor: "foxshield", kind: "shield.scan", data: scan }); }, ...(options.pass ? { fieldHints: options.pass.hints } : {}) });
  const paw = {
    ...shielded,
    snapshot: async (tabId: number, api?: ScriptingApi) => {
      await options.pass?.beforeRead(tabId, { emit: runEmit, ...(runSignal ? { signal: runSignal } : {}) });
      return (lastPage = await shielded.snapshot(tabId, api));
    },
  };
  const tabTools = [...(options.makeTools?.(() => target) ?? browserTools({ tabId: () => target, browser: browser as never, paw })), ...(options.moreTabTools?.(() => target) ?? [])]
    .map((tool) => (tool.name !== "click" ? tool : {
      ...tool,
      describe: async (args: Record<string, unknown>, ctx: ToolContext) => [await tool.describe?.(args, ctx), formDetail(lastPage, String(args.controlId), lastTyped)].filter(Boolean).join(" "),
    }));
  const extra = options.extraTools ?? [];
  let foxpay: Foxpay | undefined;
  let payRun: PayRun = { off: "No run.", key: "", ask: async () => null };
  const tools = [...tabTools, ...extra.map((e) => e.tool), ...(options.pay ? [payTool(() => foxpay!, () => payRun)] : [])];
  const { gate, host } = createFoxgate({ tools: { ...toolSpecs(tools), ...(options.pay ? payTools() : {}) }, ...(options.publicSuffix ? { publicSuffix: options.publicSuffix } : {}) });
  if (options.pay) foxpay = createFoxpay({ gate, store: options.pay.store, methods: { x402: options.pay.x402 }, onEvent: async (event) => { await trail.append(event); } });
  const approvals = createApprovals({ host, trail });
  const runMs = options.runMs ?? 10 * 60_000;
  const pageProblem = options.pageProblem ?? (async (tabId: number) => foxpaw.problemOf(await foxpaw.snapshot(tabId, browser as never)));

  // Good tool results in the current run (one run at a time).
  let worked = 0;
  // The newest tool result was good (G22).
  let lastOk = false;
  // When the newest result has no check, a tool must have worked in this run (G15), and
  // the page must show no error page to foxpaw (G10).
  const check = async ({ lastCheck }: { lastCheck?: CheckResult }): Promise<CheckResult> => {
    if (lastCheck) return lastCheck;
    if (!worked) return { ok: false, checks: [{ part: "a tool ran with a good result", ok: false, evidence: "no tool ran" }], problem: "nothing was done" };
    if (!lastOk) return { ok: false, checks: [{ part: "the last step worked", ok: false, evidence: "the newest tool result is a failure" }], problem: "the last step did not work" };
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
    runEmit = emit;
    runSignal = input.signal;
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
      if (loan?.state && loan.state !== "active") return await refuse("loan-not-active", "The loan for this tab is not active.");
      const onLoan = (h: string) => h === loan?.domain || (loan?.site !== undefined && (h === loan.site || h.endsWith(`.${loan.site}`)));
      if (loan && (loan.domain || loan.site) && !(domain && onLoan(domain))) return await refuse("loan-host", `The lent tab is on ${domain ?? "no web page"}, not on the lent site.`);
      await trail.append({ actor: "user", kind: "run.start", data: { goal: input.goal, domain: domain ?? null, planner: input.mind ? "foxbridge" : (input.settings.planner ?? "saluki"), loan: Boolean(loan) } });
      const recalled = options.memory && !input.mind ? await recallNotes(options.memory, input.goal) : { notes: [] };
      if (!input.mind) emit({ type: "recall", ...recalled });
      const goal = withNotes(input.goal, recalled.notes);
      let brain: { mind: MindLike; planner: string } | undefined = input.mind && { mind: input.mind, planner: "foxbridge" };
      if (!brain) try {
        brain = await createBrain(input.settings, {
          goal,
          ...(options.browserModel ? { browserModel: options.browserModel } : {}),
        });
      } catch (error) {
        if (error instanceof BrainError) return await refuse(error.code, error.message);
        throw error;
      }
      emit({ type: "start", planner: brain.planner, goal });
      target = input.tabId;
      const expiresAt = Date.now() + runMs;
      const scopes = loan ? SCOPES.slice(0, SCOPES.indexOf(loan.scope) + 1) : SCOPES;
      // The tab's grants. Once the run holds private data, open_url and every fill tool
      // need an approval: their arguments can carry the data to the page (G16, G17).
      let tabGrants: string[] = [];
      let privateSource: string | undefined;
      const grantTab = async () => {
        if (!domain) return;
        for (const id of tabGrants) await host.revokeGrant(id).catch(() => undefined);
        tabGrants = [];
        const add = async (grant: Parameters<Host["addGrant"]>[0]) => {
          const { id } = await host.addGrant(grant);
          tabGrants.push(id);
          grants.push(id);
        };
        for (const scope of scopes) {
          if (!privateSource || scope === "submit") {
            await add({ scope, domains: [domain], expiresAt });
          } else if (scope === "fill") {
            await add({ scope, domains: [domain], expiresAt, approval: "always" });
          } else {
            const reads = tabTools.filter((t) => t.scope === "read" && t.name !== "open_url").map((t) => t.name);
            if (reads.length) await add({ scope, domains: [domain], expiresAt, tools: reads });
            if (tabTools.some((t) => t.name === "open_url")) await add({ scope, domains: [domain], expiresAt, tools: ["open_url"], approval: "always" });
          }
        }
      };
      const goPrivate = async (source: string) => {
        if (privateSource) return;
        privateSource = source;
        emit({ type: "private", source });
        await trail.append({ actor: "foxmate", kind: "run.private", data: { source } });
        await grantTab();
      };
      if (recalled.notes.length) await goPrivate("memory notes");
      else await grantTab();
      const privateTools = new Set(extra.filter((e) => e.private).map((e) => e.tool.name));
      if (options.pay) {
        // The paid answer is private data (PY10). A loan run never pays (PY7). The cap is for this run only.
        privateTools.add("pay");
        const cap = domain && !loan ? await options.pay.cap() : 0;
        const off = loan ? "foxmate does not pay on a lent login." : cap > 0 ? undefined : "Payments are off. The user can set a spending cap in Settings.";
        payRun = {
          ...(off ? { off } : {}),
          key: input.runKey ?? crypto.randomUUID(),
          ask: async (requestId, detail, ctx) => {
            approvals.expect(requestId);
            const request = (await host.pending()).find((r) => r.id === requestId);
            if (!request) return null;
            emit({ type: "approval-needed", step: ctx.step, id: `pay-${requestId}`, requestId, action: request.action, expiresAt: request.expiresAt, detail, exactText: request.text });
            return approvals.ask({ step: ctx.step, requestId, action: request.action, expiresAt: request.expiresAt, detail });
          },
        };
        if (domain) grants.push((await host.addGrant({ scope: "read", domains: [domain], tools: ["pay"], expiresAt })).id);
        if (domain && !off) grants.push((await host.addGrant({ scope: "pay", domains: [domain], tools: [PAY_TOOL], spendCap: { value: cap, currency: GATE_CURRENCY.USDC ?? "XTS" }, approval: "always", expiresAt })).id);
      }
      const granted = extra.filter((e) => scopes.includes(e.tool.scope) && (!e.optIn || input.allowPrivate || !domain));
      for (const { tool, domain: own } of granted) grants.push((await host.addGrant({ scope: tool.scope, domains: [own], tools: [tool.name], expiresAt })).id);
      const redact = options.redact;
      const plannerMind: MindLike = redact
        ? { chat: async (messages, chatOptions) => brain.mind.chat(JSON.parse(await redact(JSON.stringify(messages))) as typeof messages, chatOptions) }
        : brain.mind;
      const loop = createLoop({ mind: plannerMind, gate, tools, trail, check, maxSteps: options.maxSteps ?? 20, budget: { ms: runMs }, onApproval: (request) => approvals.ask(request) });
      let end: RunEnd = { status: "aborted" };
      worked = 0;
      lastOk = false;
      lastTyped = undefined;
      for await (const event of loop.run(goal, input.signal ? { signal: input.signal } : {})) {
        if (event.type === "approval-needed") {
          approvals.expect(event.requestId);
          // ask() reads foxgate's text when foxloop calls it; read it here too, for the event.
          const text = (await host.pending()).find((r) => r.id === event.requestId)?.text;
          emit({ ...event, ...(text ? { exactText: text } : {}) });
        } else emit(event);
        if (event.type === "tool-call" && event.name === "act" && (event.args as { op?: string } | undefined)?.op === "type") lastTyped = String((event.args as { controlId?: unknown }).controlId);
        if (event.type === "tool-result") lastOk = event.ok;
        if (event.type === "tool-result" && event.ok) worked += 1;
        if (event.type === "tool-result" && event.ok && privateTools.has(event.name)) await goPrivate(event.name);
        if (event.type === "done") end = { status: "done", summary: event.summary };
        if (event.type === "blocked") end = { status: "blocked", reason: event.reason, message: event.message };
      }
      return end;
    } finally {
      payRun = { off: "No run.", key: "", ask: async () => null };
      runEmit = noEvent;
      runSignal = undefined;
      approvals.cancelAll();
      for (const id of grants) await host.revokeGrant(id).catch(() => undefined);
      busy = false;
      await trail.append({ actor: "foxmate", kind: "run.end", data: {} }).catch(() => undefined);
    }
  }

  return { gate, host, approvals, get busy() { return busy; }, run };
}
