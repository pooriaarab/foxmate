// Approvals: foxloop asks, a human answers from the sidebar or the phone.
// The first answer for a request decides it, and only that request
// (docs/failure-modes.md A1-A6). The text shown is foxgate's canonical
// JSON of the exact action, so what the human reads is what can run.
import type { Host } from "foxgate";
import type { ApprovalRequest } from "foxloop";

export type Answer = "approve" | "deny";

export interface Waiting {
  requestId: string;
  /** foxgate's canonical JSON of the action. */
  text: string;
  detail?: string;
  expiresAt: number;
}

export interface ApprovalsOptions {
  host: Pick<Host, "approve" | "reject" | "pending">;
  trail?: { append(entry: { actor: string; kind: string; data?: unknown }): Promise<unknown> };
}

export interface Approvals {
  /** For foxloop's `onApproval`: resolves with a foxgate token, or null for no. */
  ask(request: ApprovalRequest): Promise<string | null>;
  /** `decided` when this answer decided the request, `late` when another one did, `unknown` for no such request. */
  answer(requestId: string, answer: Answer, via: string): Promise<"decided" | "late" | "unknown">;
  waiting(): Waiting[];
  /** The current run announced this request: only such requests can be answered (A7). */
  expect(requestId: string): void;
  /** Ends every waiting request as no, and rejects the run's open requests in foxgate. */
  cancelAll(): void;
  /** Calls fn when the list of waiting requests changes. Returns a function that removes it. */
  onChange(fn: (waiting: Waiting[]) => void): () => void;
}

export function createApprovals(options: ApprovalsOptions): Approvals {
  const open = new Map<string, { waiting: Waiting; resolve: (token: string | null) => void; timer: ReturnType<typeof setTimeout> }>();
  // Answers that came before foxloop asked, and requests already decided.
  const early = new Map<string, string | null>();
  const decided = new Set<string>();
  // Requests that the current run announced. An answer to any other request is unknown.
  const live = new Set<string>();
  const listeners = new Set<(waiting: Waiting[]) => void>();
  const changed = () => {
    const list = [...open.values()].map((o) => o.waiting);
    for (const fn of listeners) fn(list);
  };
  const settle = (requestId: string, token: string | null) => {
    const entry = open.get(requestId);
    if (!entry) return false;
    open.delete(requestId);
    clearTimeout(entry.timer);
    entry.resolve(token);
    changed();
    return true;
  };

  return {
    async ask(request) {
      if (early.has(request.requestId)) {
        const token = early.get(request.requestId) ?? null;
        early.delete(request.requestId);
        return token;
      }
      const pending = (await options.host.pending()).find((r) => r.id === request.requestId);
      if (!pending) return null;
      return new Promise((resolve) => {
        const timer = setTimeout(() => settle(request.requestId, null), Math.max(0, request.expiresAt - Date.now()));
        const waiting: Waiting = { requestId: request.requestId, text: pending.text, expiresAt: request.expiresAt, ...(request.detail ? { detail: request.detail } : {}) };
        open.set(request.requestId, { waiting, resolve, timer });
        changed();
      });
    },
    async answer(requestId, answer, via) {
      if (decided.has(requestId)) return "late";
      if (!open.has(requestId) && !(live.has(requestId) && (await options.host.pending()).some((r) => r.id === requestId))) return "unknown";
      if (decided.has(requestId)) return "late";
      decided.add(requestId);
      let token: string | null = null;
      if (answer === "approve") token = await options.host.approve(requestId).catch(() => null);
      else await options.host.reject(requestId).catch(() => undefined);
      // No record, no approval: a failed trail write turns the answer into no.
      await options.trail?.append({ actor: "user", kind: "approval.answer", data: { requestId, decision: answer, via } }).catch(() => {
        token = null;
      });
      if (!settle(requestId, token)) early.set(requestId, token);
      return "decided";
    },
    waiting: () => [...open.values()].map((o) => o.waiting),
    expect(requestId) {
      live.add(requestId);
    },
    cancelAll() {
      // foxgate keeps a pending request for 10 minutes and reuses it for the same action,
      // so a late answer could approve the next run. Reject them all now.
      for (const requestId of new Set([...live, ...open.keys()])) {
        if (!decided.has(requestId)) void options.host.reject(requestId).catch(() => undefined);
      }
      for (const requestId of open.keys()) settle(requestId, null);
      live.clear();
      early.clear();
    },
    onChange(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}
