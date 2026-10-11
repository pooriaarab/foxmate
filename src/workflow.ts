// The workflow cache: the calls of a run that ended done, kept for its origin
// and goal, and replayed on the next run of the same goal; the planner still
// writes the finish (docs/failure-modes.md WF1-WF11). Each replayed call is a planner reply: the
// gate checks it and every approval is asked again.
import type { Message } from "foxloop";
import type { Snapshot } from "foxpaw";

/** One kept call. A call on a control keeps the control's role, label and submit flag, not its id (WF1). */
export interface WorkflowStep {
  name: string;
  args: Record<string, unknown>;
  control?: { role: string; label: string; submit: boolean };
  /** For ask_user: the answer the user gave. Another answer ends the replay (WF4). */
  answer?: string;
}

export interface Workflow {
  steps: WorkflowStep[];
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

/** The call to replay for a step, or why the replay ends (WF1, WF2, WF5). */
export function replayCall(step: WorkflowStep, page: Snapshot | undefined, messages: readonly Message[], tainted: boolean): { name: string; arguments: string } | string {
  if (tainted) return "foxshield flagged a page of this run";
  const at = messages.findLastIndex((m) => m.role === "assistant");
  const failed = messages.slice(at + 1).some((m) => (m.role === "tool" || m.role === "user") && /^\S+: failed$/.test((m.content ?? "").split("\n")[0] ?? ""));
  if (failed) return "the last step failed";
  if (!step.control) return { name: step.name, arguments: JSON.stringify(step.args) };
  if (!page) return "there is no snapshot to find the control in";
  const { role, label, submit } = step.control;
  const found = page.controls.filter((c) => c.role === role && c.label === label && c.submit === submit);
  if (found.length !== 1) return found.length ? `${found.length} controls are ${role} "${label}"` : `no control is ${role} "${label}" now`;
  return { name: step.name, arguments: JSON.stringify({ controlId: found[0]!.id, ...step.args }) };
}
