// Recall: the user's memories that fit a goal, as notes under the goal.
// The goal is trusted text, so only memories the user wrote (`source:
// "user"`) become notes, without markup or hidden characters
// (docs/failure-modes.md M1-M6).
import type { FoxMemory } from "foxmemory";

export interface RecallOptions {
  /** The most notes. Default 5. */
  k?: number;
  /** The lowest cosine similarity. Default 0.3. */
  minScore?: number;
}

export interface Recalled {
  notes: string[];
  /** Why recall failed, when it did. The run goes on with no notes. */
  error?: string;
}

const MAX_NOTE = 300;
// Zero-width, bidi and other format characters, and control characters.
// oxlint-disable-next-line no-control-regex
const HIDDEN = /[\u0000-\u0008\u000b-\u001f\u007f­؜᠎​-‏‪-‮⁠-⁤⁦-⁯﻿]/g;

function clean(text: string): string {
  const plain = text.replace(HIDDEN, "").replace(/[<>]/g, "").replace(/\s+/g, " ").trim();
  return plain.length > MAX_NOTE ? `${plain.slice(0, MAX_NOTE - 1)}…` : plain;
}

/** The user's memories that fit the goal. Never throws. */
export async function recallNotes(memory: Pick<FoxMemory, "recall">, goal: string, options: RecallOptions = {}): Promise<Recalled> {
  const k = options.k ?? 5;
  try {
    // Ask for more than k: memories from other sources are dropped after.
    const hits = await memory.recall(goal, { k: k * 3, minScore: options.minScore ?? 0.3 });
    const notes = hits.filter((h) => h.memory.source === "user").map((h) => clean(h.memory.text)).filter(Boolean);
    return { notes: [...new Set(notes)].slice(0, k) };
  } catch (error) {
    return { notes: [], error: error instanceof Error ? error.message : String(error) };
  }
}

/** The goal with the notes under it. A goal with no notes stays as it is. */
export function withNotes(goal: string, notes: readonly string[]): string {
  return notes.length ? `${goal}\n\nNotes the user saved in foxmate:\n${notes.map((n) => `- ${n}`).join("\n")}` : goal;
}
