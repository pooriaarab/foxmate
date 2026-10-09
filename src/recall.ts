// Recall: the user's memories that fit a goal, as notes under the goal.
// The goal is trusted text, so only memories the user wrote (`source:
// "user"`) become notes, without markup or hidden characters
// (docs/failure-modes.md M1-M6).
import type { FoxMemory } from "foxmemory";

export interface RecallOptions {
  /** The most notes. Default 5. */
  k?: number;
  /** The lowest cosine similarity. Default 0.2: in our test, MiniLM gave a fitting note 0.26 and an unrelated one 0.06. */
  minScore?: number;
}

export interface Recalled {
  notes: string[];
  /** Why recall failed, when it did. The run goes on with no notes. */
  error?: string;
}

const MAX_NOTE = 300;
/** The line above the notes in a goal. */
export const NOTES_HEADER = "Notes the user saved in foxmate:";
// Zero-width, bidi and other format characters, and control characters.
// oxlint-disable-next-line no-control-regex
const HIDDEN = /[\u0000-\u0008\u000b-\u001f\u007f\u00ad\u061c\u180e\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u206f\ufeff]/g;

function clean(text: string): string {
  const plain = text.replace(HIDDEN, "").replace(/[<>]/g, "").replace(/\s+/g, " ").trim();
  return plain.length > MAX_NOTE ? `${plain.slice(0, MAX_NOTE - 1)}…` : plain;
}

/** The user's memories that fit the goal. Never throws. */
export async function recallNotes(memory: Pick<FoxMemory, "recall">, goal: string, options: RecallOptions = {}): Promise<Recalled> {
  const k = options.k ?? 5;
  try {
    // Ask for more than k: memories from other sources are dropped after.
    const hits = await memory.recall(goal, { k: k * 3, minScore: options.minScore ?? 0.2 });
    const notes = hits.filter((h) => h.memory.source === "user").map((h) => clean(h.memory.text)).filter(Boolean);
    return { notes: [...new Set(notes)].slice(0, k) };
  } catch (error) {
    return { notes: [], error: error instanceof Error ? error.message : String(error) };
  }
}

/** The goal with the notes under it. A goal with no notes stays as it is. */
export function withNotes(goal: string, notes: readonly string[]): string {
  return notes.length ? `${goal}\n\n${NOTES_HEADER}\n${notes.map((n) => `- ${n}`).join("\n")}` : goal;
}
