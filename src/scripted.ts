// The scripted planner: it replays a JSON list of tool calls, so foxmate,
// its E2E test and `foxmate bench` run with no model. It is as naive as a
// small model: it copies what the page shows.
//
// In string arguments:
//   {{goal}}            the goal, with the notes that foxmate added
//   {{lastUrl}}         the last http(s) address in the newest tool result
//   {{notes}}           the notes under the goal, joined with ", "
//   {{control:Label}}   the id of the first control in the newest snapshot
//                       whose label has that text
// A step `{ "tool": "x", "if": "Label" }` runs only when the newest
// snapshot has a control with that label; else the planner skips it.
import { scriptedMind, type Message, type ScriptReply } from "foxloop";
import { NOTES_HEADER } from "./recall.js";

export interface ScriptStepJson {
  tool?: string;
  args?: Record<string, unknown>;
  text?: string;
  if?: string;
}

export class ScriptError extends Error {
  readonly code = "bad-script";
}

const newestTool = (messages: readonly Message[]) => messages.findLast((m) => m.role === "tool")?.content ?? "";

const lastUrl = (messages: readonly Message[]) => newestTool(messages).match(/https?:\/\/[^\s"'<>)\]]+/g)?.at(-1) ?? "";

const controlId = (messages: readonly Message[], label: string) => {
  const text = messages.findLast((m) => m.role === "tool" && m.content?.includes("Controls:"))?.content ?? "";
  const line = text.split("\n").find((l) => l.startsWith("[") && l.toLowerCase().includes(label.toLowerCase()));
  return line?.match(/^\[([^\]]+)\]/)?.[1] ?? "";
};

/** Parses a script. Throws ScriptError when it is not a JSON array of steps. */
export function parseScript(script: string): ScriptStepJson[] {
  let steps: unknown;
  try {
    steps = JSON.parse(script);
  } catch {
    throw new ScriptError("The script is not JSON. Write a JSON array of steps.");
  }
  if (!Array.isArray(steps) || steps.some((s) => !s || typeof s !== "object")) throw new ScriptError("The script must be a JSON array of steps.");
  return steps as ScriptStepJson[];
}

/** A foxloop planner that replays `script` for `goal`. */
export function scriptMind(script: string, goal: string) {
  const steps = parseScript(script);
  const notes = (goal.split(`\n\n${NOTES_HEADER}\n`)[1] ?? "").split("\n").map((l) => l.replace(/^- /, "").trim()).filter(Boolean).join(", ");
  let at = 0;
  const next = (messages: Message[]): ScriptReply => {
    for (;;) {
      const step = steps[at++];
      if (!step) return { calls: [{ name: "finish", args: { summary: "The script ended." } }] };
      if (step.if && !controlId(messages, step.if)) continue;
      const fill = (value: unknown): unknown => {
        if (typeof value === "string") {
          return value.replaceAll("{{goal}}", goal).replaceAll("{{notes}}", notes).replaceAll("{{lastUrl}}", lastUrl(messages))
            .replace(/\{\{control:([^}]+)\}\}/g, (_, label: string) => controlId(messages, label));
        }
        if (Array.isArray(value)) return value.map(fill);
        if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fill(v)]));
        return value;
      };
      return step.tool ? { calls: [{ name: step.tool, args: fill(step.args ?? {}) as Record<string, unknown> }] } : { text: String(fill(step.text ?? "")) };
    }
  };
  // One step function per model call; each reads the history it gets.
  return scriptedMind(Array.from({ length: steps.length + 1 }, () => next));
}
