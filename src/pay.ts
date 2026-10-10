// Payments through foxpay (docs/failure-modes.md PY1-PY12). The planner asks
// to pay a bill on the tab's host with x402. foxpay reads the real amount
// from the 402 answer, foxgate checks the cap, and a human approves each
// payment. The call itself only reads the quote; the payment is a foxgate
// pay action with its own approval.
import type { Store } from "foxgate";
import type { LoopTool, ToolContext, ToolOutput } from "foxloop";
import type { Foxpay, PayMethod } from "foxpay-agent";

export interface PayOptions {
  /** foxpay's x402 method, with the wallet in foxvault and the payee of each host. */
  x402: PayMethod;
  /** Where foxpay keeps intents and receipts. In Firefox, storage.local. */
  store: Store;
  /** The spending cap for one goal, in atomic test USDC (6 decimals). 0 turns payments off. */
  cap: () => Promise<number>;
}

/** What the pay tool needs from the current run. */
export interface PayRun {
  /** Why payments are off in this run, or undefined when they are on. */
  off?: string;
  /** The same for each attempt of one task, so a replay finds the first receipt (PY5). */
  key: string;
  /** Shows the approval for a foxgate request. Resolves with a token, or null for no. */
  ask: (requestId: string, detail: string, ctx: ToolContext) => Promise<string | null>;
}

/** "0.01" -> 10000 atomic units. Undefined for anything else. */
export function toAtomic(amount: unknown): number | undefined {
  if (typeof amount !== "string" || !/^\d{1,9}(\.\d{1,6})?$/.test(amount.trim())) return undefined;
  const [whole = "0", part = ""] = amount.trim().split(".");
  const value = Number(whole) * 1e6 + Number(part.padEnd(6, "0"));
  return value > 0 ? value : undefined;
}

/** 10000 -> "0.01". */
export const fromAtomic = (value: number) => (value / 1e6).toFixed(6).replace(/0{1,4}$/, "");

/** "host address" lines from Settings -> { host: address }. Other lines are left out. */
export function parsePayees(text: unknown): Record<string, string> {
  const payees: Record<string, string> = {};
  for (const line of String(text ?? "").split("\n")) {
    const [host, address, more] = line.trim().split(/\s+/);
    if (host && address && !more && /^0x[0-9a-fA-F]{40}$/.test(address)) payees[host.toLowerCase()] = address;
  }
  return payees;
}

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const refusal = (summary: string): ToolOutput => ({ ok: false, summary });

/** The planner's pay tool. `foxpay` and `run` are read at each call. */
export function payTool(foxpay: () => Foxpay, run: () => PayRun): LoopTool {
  return {
    name: "pay",
    description: "Pay a bill on this site with test USDC (x402). Give the payment address from the page, the amount due and why. The user approves each payment.",
    parameters: { type: "object", required: ["url", "amount", "reason"], properties: {
      url: { type: "string", maxLength: 2000, description: "The address that asks for the payment." },
      amount: { type: "string", maxLength: 20, description: 'The amount due in USDC, for example "0.25".' },
      reason: { type: "string", maxLength: 200 },
    } },
    scope: "read",
    domain: (args) => new URL(String(args.url)).hostname,
    async run(args, ctx) {
      const current = run();
      if (current.off) return refusal(current.off);
      const amount = toAtomic(args.amount);
      if (!amount) return refusal('The amount must be a number of USDC, for example "0.25".');
      const url = String(args.url);
      // A changed amount or address is a new intent, with its own approval (PY4).
      const idempotencyKey = await sha256(`${current.key}\n${url}\n${amount}`);
      const pay = foxpay();
      let result = await pay.request({ merchant: ctx.domain, amount, currency: "USDC", reason: String(args.reason), method: "x402", idempotencyKey, target: { url } });
      if (result.status === "ask") {
        const { id, requestId } = result;
        const intent = (await pay.intents()).find((i) => i.id === id);
        const detail = intent ? `Pay ${fromAtomic(intent.amount)} ${intent.currency} to ${intent.payee} on ${intent.merchant}, for "${intent.reason}".` : "";
        const token = await current.ask(requestId, detail, ctx);
        if (!token) return refusal("The user did not approve the payment. Nothing was paid.");
        result = await pay.complete(id, token);
      } else if (result.status !== "refused") {
        // The pay grant always asks, so a result with no approval is a receipt from before (PY5).
        return refusal(`This payment already ran (${result.status}). foxmate does not pay it again.`);
      }
      if (result.status === "refused") return refusal(`foxpay refused the payment (${result.reason}): ${result.message}`);
      const receipt = result.receipt;
      const ok = receipt.status === "paid";
      const summary = ok ? `Paid ${fromAtomic(receipt.amount)} USDC to ${receipt.payee}.` : `The payment is ${receipt.status} (${receipt.failure ?? "no reason"}). Money may have moved: check before you pay again.`;
      return { ok, summary, ...(result.body ? { untrusted: result.body } : {}), check: { ok, checks: [{ part: "foxpay receipt", ok, evidence: receipt.status }] } };
    },
  };
}
