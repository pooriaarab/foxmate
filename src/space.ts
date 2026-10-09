// The Space tool: Python on the files the user dropped, through foxden. The
// den runs in a sandbox page with no network and no extension APIs
// (docs/failure-modes.md D1-D5). The output is data, not instructions.
import type { LoopTool } from "foxloop";

export const SPACE_DOMAIN = "space.foxmate";

/** The parts of a foxden den that the tool uses. */
export interface DenLike {
  run(code: string, options?: { timeoutMs?: number; maxOutputBytes?: number }): Promise<{ stdout: string; stderr: string; result: string | null; error: { kind: string; message?: string } | null; truncated?: boolean }>;
  list(): Promise<{ path: string; size: number }[] | string[]>;
}

const cut = (text: string, max = 4000) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

export function spaceTool(den: () => Promise<DenLike>): LoopTool {
  return {
    name: "run_python",
    description: "Run Python 3 (standard library only, no network) on the files in the Space. Dropped files are in /drop. Write results to /out. The value of the last expression comes back.",
    parameters: { type: "object", properties: { code: { type: "string", minLength: 1, maxLength: 20_000 } }, required: ["code"] },
    scope: "fill",
    domain: () => SPACE_DOMAIN,
    describe: () => "run Python in the Space (no network)",
    async run(args) {
      const space = await den();
      const reply = await space.run(String(args.code), { timeoutMs: 30_000, maxOutputBytes: 64_000 });
      const ok = !reply.error;
      const files = (await space.list()).map((f) => (typeof f === "string" ? f : f.path)).join(", ");
      const untrusted = [
        reply.result === null ? "" : `Result: ${cut(reply.result)}`,
        reply.stdout ? `Output:\n${cut(reply.stdout)}` : "",
        reply.stderr ? `Errors:\n${cut(reply.stderr)}` : "",
        reply.error ? `Python stopped: ${reply.error.kind}${reply.error.message ? `: ${cut(reply.error.message, 500)}` : ""}` : "",
        `Files: ${files || "none"}`,
      ].filter(Boolean).join("\n");
      return {
        ok,
        summary: ok ? "Python ran in the Space." : `Python stopped with an error (${reply.error?.kind}).`,
        untrusted,
        check: { ok, checks: [{ part: "Python ran without an error", ok, evidence: ok ? (reply.result ?? "no result") : (reply.error?.kind ?? "error") }] },
        data: { result: reply.result, error: reply.error },
      };
    },
  };
}
