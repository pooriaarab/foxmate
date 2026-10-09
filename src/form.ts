// What an approval to click a form button shows: the other fields of that
// form and their values, from the newest snapshot (docs/failure-modes.md
// G11). foxpaw shows a password as "•••", so it stays masked here.
import type { Snapshot } from "foxpaw";

const MAX_VALUE = 80;
const MAX_TEXT = 240;

/**
 * "The form holds: To: "x"; ..." for the form of the control, or "" when it
 * sends no form. The field the planner typed last (`typedId`) is shown in full (G21).
 */
export function formDetail(page: Snapshot | undefined, controlId: string, typedId?: string): string {
  const button = page?.controls.find((c) => c.id === controlId);
  if (!page || !button?.submit || button.form === undefined) return "";
  const fields = page.controls
    .filter((c) => c.form === button.form && c.frameId === button.frameId && c.id !== button.id && !c.submit)
    .map((c) => {
      if (c.role === "checkbox" || c.role === "radio" || c.role === "switch") return c.checked ? `${c.label}: checked` : "";
      if (!c.value) return "";
      const value = c.value.length > MAX_VALUE ? `${c.value.slice(0, MAX_VALUE - 1)}…` : c.value;
      return `${c.label}: "${value}"`;
    })
    .filter(Boolean);
  if (!fields.length) return "";
  const text = `The form holds: ${fields.join("; ")}.`;
  const cut = text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT - 1)}…` : text;
  const typed = page.controls.find((c) => c.id === typedId && c.form === button.form && c.value && !c.secret);
  return typed && typed.value.length > MAX_VALUE - 1 ? `${cut} In full, ${typed.label}: "${typed.value}".` : cut;
}
