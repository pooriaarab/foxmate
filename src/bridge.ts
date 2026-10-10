// One call from an outside agent (Claude Code over foxbridge), as a run of
// its own through the agent (docs/failure-modes.md BR2-BR6). The planner of
// that run asks for the call, reads the result as any planner would, and
// finishes. So foxgate, foxshield and the approvals in Chat all apply.
import { scriptedMind, type Message, type MindLike } from "foxloop";
import type { AgentEvent, RunEnd } from "./agent.js";

export interface BridgeCall {
  /** A foxloop tool name, for example `snapshot`, `act` or `browser_task`. */
  name: string;
  args: Record<string, unknown>;
}

/** What foxbridge sends back to the agent for a call that ran. */
export interface BridgeReply {
  ok: boolean;
  summary: string;
  /** The result as the planner reads it: page text between foxloop's data marks. */
  untrusted?: string;
}

/** A refusal with one of foxbridge's codes, for example `denied` or `approval-denied`. */
export class BridgeRefusal extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

const CODES: Record<string, string> = { "approval-denied": "approval-denied", "gate-deny": "denied", aborted: "approval-cancelled" };

/** Runs `call` with `run(mind, onEvent)`, for example agent.run. Resolves with the reply, or throws BridgeRefusal. */
export async function bridgeCall(run: (mind: MindLike, onEvent: (event: AgentEvent) => void) => Promise<RunEnd>, call: BridgeCall): Promise<BridgeReply> {
  let seen = "";
  const finish = (messages: Message[]) => {
    seen ||= messages.findLast((m) => m.role === "tool")?.content ?? "";
    return { calls: [{ name: "finish", args: { summary: "The outside agent's call ran." } }] };
  };
  // A failed result makes the check fail, and the loop asks again: give it a few finishes.
  const mind = scriptedMind([{ calls: [call] }, finish, finish, finish, finish]);
  let result: Extract<AgentEvent, { type: "tool-result" }> | undefined;
  const end = await run(mind, (event) => {
    if (event.type === "tool-result") result = event;
  });
  if (result) return { ok: result.ok, summary: result.summary, ...(seen ? { untrusted: seen } : {}) };
  const code = end.status === "refused" ? (end.reason ?? "refused") : (CODES[end.reason ?? end.status] ?? "error");
  throw new BridgeRefusal(code, end.message ?? `The call did not run (${end.reason ?? end.status}).`);
}
