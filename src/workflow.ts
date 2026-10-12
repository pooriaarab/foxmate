// The workflow cache: the calls of a run that ended done, kept for its origin
// and goal, and replayed on the next run of the same goal; the planner still
// writes the finish (docs/failure-modes.md WF1-WF21). Each replayed call is a planner reply: the
// gate checks it and every approval is asked again.
import type { Message } from "foxloop";
import type { Snapshot } from "foxpaw";

/** One kept call. A call on a control keeps the control's role, label and submit flag, not its id (WF1). */
export interface WorkflowStep {
  name: string;
  args: Record<string, unknown>;
  control?: { role: string; label: string; submit: boolean; must?: string[] };
  /** For ask_user: the answer the user gave. Another answer ends the replay (WF4). */
  answer?: string;
}

export interface Workflow {
  steps: WorkflowStep[];
  /** The goal of the run that was kept, for a replay under its shape (WF12). */
  goal?: string;
}

/** Where the kept workflows live, for example browser.storage.local. */
export interface WorkflowStore {
  get(key: string): Promise<Workflow | undefined>;
  set(key: string, workflow: Workflow): Promise<void>;
}

/** The key of a workflow: the tab's origin and the goal with its memory notes, with spaces made one. */
export const workflowKey = (origin: string, goal: string) => `${origin}\n${goal.trim().replace(/\s+/g, " ")}`;

/**
 * The step to keep for a call that worked. Undefined when the call names a
 * control that the snapshot does not have; null when it typed into a password
 * field, so the run keeps nothing (WF6).
 */
export function toStep(name: string, args: Record<string, unknown>, page: Snapshot | undefined): WorkflowStep | null | undefined {
  if (args.controlId === undefined) return { name, args };
  const c = page?.controls.find((x) => x.id === args.controlId);
  if (!c) return undefined;
  if (c.secret && args.op === "type") return null;
  const { controlId: _id, ...rest } = args;
  return { name, args: rest, control: { role: c.role, label: c.label, submit: c.submit } };
}

/** Text as lower-case words with a plural "s" taken off, for a loose label match (WF17). */
const words = (text: string) => ` ${text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean).map((w) => w.replace(/(?<=\w{3})e?s$/, "")).join(" ")} `;

/** Each part in the label's words, one after another, in this order (WF17, WF21). */
function inOrder(label: string, parts: readonly string[]): boolean {
  const text = words(label);
  let at = 0;
  for (const part of parts) {
    const w = words(part);
    const i = text.indexOf(w, at);
    if (i < 0) return false;
    at = i + w.length - 1;
  }
  return true;
}

/** The steps to keep for foxloop's `fill`: one `act` step for each field that ran, on the page the call was planned on (WF22, WF23). */
export function fillSteps(filled: readonly { controlId: string; op: string; value?: string }[], page: Snapshot | undefined): WorkflowStep[] | null | undefined {
  const steps: WorkflowStep[] = [];
  for (const f of filled) {
    const step = toStep("act", { controlId: f.controlId, op: f.op, ...(f.value !== undefined ? { value: f.value } : {}) }, page);
    if (!step) return step;
    steps.push(step);
  }
  return steps;
}

/** The call to replay for a step, or why the replay ends (WF1, WF2, WF5). */
export function replayCall(step: WorkflowStep, page: Snapshot | undefined, messages: readonly Message[], tainted: boolean): { name: string; arguments: string } | string {
  if (tainted) return "foxshield flagged a page of this run";
  const at = messages.findLastIndex((m) => m.role === "assistant");
  const failed = messages.slice(at + 1).some((m) => (m.role === "tool" || m.role === "user") && /^\S+: failed$/.test((m.content ?? "").split("\n")[0] ?? ""));
  if (failed) return "the last step failed";
  if (!step.control) return { name: step.name, arguments: JSON.stringify(step.args) };
  if (!page) return "there is no snapshot to find the control in";
  const { role, label, submit } = step.control;
  let found = page.controls.filter((c) => c.role === role && c.label === label && c.submit === submit);
  // A rewritten label is a guess: else the one control that holds each new value, in the same order (WF17, WF21).
  const must = step.control.must;
  if (!found.length && must?.length) found = page.controls.filter((c) => c.role === role && c.submit === submit && inOrder(c.label, must));
  if (found.length !== 1) return found.length ? `${found.length} controls are ${role} "${label}"` : `no control is ${role} "${label}" now`;
  return { name: step.name, arguments: JSON.stringify({ controlId: found[0]!.id, ...step.args }) };
}

// Goal shapes (WF12-WF17): the same task with other values replays a kept plan.
const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const NUMBER_WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];
/** One value of a goal: an email, a month-name date, a number word, or a run of words that start with a capital or a digit. */
const VALUE = new RegExp([
  String.raw`[\w.+-]+@[\w-]+(?:\.[\w-]+)+`,
  String.raw`\b(?:${MONTH_NAMES.join("|")}) \d{1,2}(?:, \d{4})?\b`,
  String.raw`(?<![\w-])(?:${NUMBER_WORDS.join("|")})(?![\w-])`,
  String.raw`[A-Z0-9](?:[\w'’/:-]|\.(?=\w))*(?: [A-Z0-9](?:[\w'’/:-]|\.(?=\w))*)*`,
].join("|"), "g");

/** The goal with its values taken out, and the values in order (WF12, WF15). */
export function goalShape(goal: string): { shape: string; values: string[] } {
  const text = goal.trim().replace(/\s+/g, " ");
  const values: string[] = [];
  let shape = "";
  let at = 0;
  for (const m of text.matchAll(VALUE)) {
    let value = m[0];
    let start = m.index;
    // The first word of a sentence is part of the instruction, not a value.
    if (/^[A-Z]/.test(value) && (start === 0 || /[.!?:]\s$/.test(text.slice(0, start)))) {
      const space = value.indexOf(" ");
      if (space < 0) continue;
      start += space + 1;
      value = value.slice(space + 1);
    }
    value = value.replace(/['’]s$/, "");
    if (value === "I") continue;
    shape += `${text.slice(at, start)}\u0000`;
    at = start + value.length;
    values.push(value);
  }
  return { shape: shape + text.slice(at), values };
}

/** The key of a goal's shape on an origin: apart from the exact goal's key (WF12). */
export const shapeKey = (origin: string, goal: string) => `${origin}\n~${goalShape(goal).shape}`;

/** A value and the other forms a planner writes it in: a date as ISO, US and long text; a number word as digits (WF13). */
function forms(value: string): string[] {
  const date = /^([A-Z][a-z]+) (\d{1,2}), (\d{4})$/.exec(value);
  const month = date ? MONTH_NAMES.indexOf(date[1]!) : -1;
  if (date && month >= 0) {
    const d = new Date(Date.UTC(Number(date[3]), month, Number(date[2]), 12));
    const mm = String(month + 1).padStart(2, "0"), dd = date[2]!.padStart(2, "0");
    const long = (o: Intl.DateTimeFormatOptions) => d.toLocaleDateString("en-US", { ...o, timeZone: "UTC" });
    return [value, `${date[3]}-${mm}-${dd}`, `${mm}/${dd}/${date[3]}`, `${month + 1}/${Number(date[2])}/${date[3]}`,
      long({ weekday: "long", month: "long", day: "numeric", year: "numeric" }), long({ weekday: "short", month: "short", day: "numeric", year: "numeric" })];
  }
  const word = NUMBER_WORDS.indexOf(value.toLowerCase());
  return word >= 0 ? [value, String(word)] : [value];
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const bounded = (s: string) => new RegExp(`(?<![\\w])${escapeRe(s)}(?![\\w])`, "gi");

/**
 * A kept step rewritten from the values of `oldGoal` to those of `goal`,
 * which has the same shape, or why a shape replay ends before it (WF13, WF14, WF18-WF20).
 */
export function generalStep(step: WorkflowStep, oldGoal: string, goal: string): WorkflowStep | string {
  const was = goalShape(oldGoal).values, now = goalShape(goal).values;
  if (was.length !== now.length) return "the goal has another shape";
  const pairs = was.map((v, i) => [forms(v), forms(now[i]!)] as const).filter(([a, b]) => a[0] !== b[0]);
  const newForms = now.flatMap(forms);
  const newWords = new Set(newForms.flatMap((f) => f.toLowerCase().split(/\W+/)).filter(Boolean));
  // Each old form, in lower case, and its new form; null when it has more than one, so a rewrite is a guess (WF18-WF20).
  const map = new Map<string, { to: string; same: boolean } | null>();
  for (const [i, v] of was.entries()) {
    const old = forms(v), fresh = forms(now[i]!);
    for (const [k, f] of old.entries()) {
      const key = f.toLowerCase(), to = fresh[k];
      const prev = map.get(key);
      if (!map.has(key)) map.set(key, to === undefined ? null : { to, same: to === f });
      else if (prev && prev.to !== to) map.set(key, null);
    }
  }
  // One pass over every old form, the longest first, so no rewrite reads the output of another (WF18, WF19).
  const keys = [...map.keys()].filter((f) => f.length >= 3).toSorted((a, b) => b.length - a.length);
  const all = keys.length ? new RegExp(`(?<![\\w])(?:${keys.map(escapeRe).join("|")})(?![\\w])`, "gi") : undefined;
  let inserted: string[] = [];
  const rewrite = (text: string): { text: string } | string => {
    inserted = [];
    const guess = "has more than one new value, so its rewrite is a guess";
    const whole = map.get(text.trim().toLowerCase());
    if (whole === null) return guess;
    if (whole) {
      if (whole.same) return { text };
      inserted = [whole.to];
      return { text: whole.to };
    }
    let ambiguous = false;
    const out = all ? text.replace(all, (m) => {
      const hit = map.get(m.toLowerCase());
      if (!hit) { ambiguous = true; return m; }
      if (hit.same) return m;
      inserted.push(hit.to);
      return hit.to;
    }) : text;
    if (ambiguous) return guess;
    // A word or number of an old value that changed, still in the text: it came from the old goal.
    const left = pairs.flatMap(([old]) => old[0]!.toLowerCase().split(/\W+/)).filter((w) => w && !newWords.has(w));
    return left.some((w) => bounded(w).test(out)) ? "may come from the old goal" : { text: out };
  };
  const args: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(step.args)) {
    if (typeof v !== "string") { args[k] = v; continue; }
    const r = rewrite(v);
    if (typeof r === "string") return `a kept ${k} ${r}`;
    args[k] = r.text;
  }
  let control = step.control;
  if (control) {
    const r = rewrite(control.label);
    if (typeof r === "string") return `a kept label ${r}`;
    const label = r.text;
    control = { ...control, label, ...(label !== control.label ? { must: inserted } : {}) };
  }
  // A number that no new value gives: a choice that depends on the values (WF14).
  const unexplained = (text: string) => /\d/.test(newForms.toSorted((a, b) => b.length - a.length).reduce((t, f) => t.replace(bounded(f), " "), text));
  if ((step.name === "click" || step.name === "act") && [control?.label ?? "", typeof args.value === "string" ? args.value : ""].some(unexplained)) {
    return "a kept choice depends on the values";
  }
  return { ...step, args, ...(control ? { control } : {}) };
}

/** Why a kept run cannot replay under the new goal's values: a changed value that no kept step uses (WF16). */
export function shapeFits(steps: WorkflowStep[], oldGoal: string, goal: string): string | undefined {
  const was = goalShape(oldGoal).values, now = goalShape(goal).values;
  if (was.length !== now.length) return "the goal has another shape";
  const texts = steps.flatMap((st) => [...Object.values(st.args).filter((v): v is string => typeof v === "string"), st.control?.label ?? ""]);
  for (const [i, v] of was.entries()) {
    if (v === now[i]) continue;
    const used = forms(v).some((f) => texts.some((t) => t.trim().toLowerCase() === f.toLowerCase() || (f.length >= 3 && bounded(f).test(t))));
    if (!used) return `no kept step uses "${v}", so "${now[i]}" has no step`;
  }
  return undefined;
}
