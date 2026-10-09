// Mail and event text from Google, through foxshield before the planner
// reads it (docs/failure-modes.md MS1-MS5). The HTML part is what the user
// sees, so foxmate prefers it over text/plain, and says which part it used.

/** foxshield's scan and sanitize for an HTML string: scanHtml in Node, scanDocument on a parsed document in Firefox. */
export type HtmlSanitizer = (html: string) => string;

export interface MailPart {
  mimeType?: string;
  body?: { data?: string };
  parts?: MailPart[];
}

const escape = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function decode(data: string): string {
  const base64 = data.replace(/-/g, "+").replace(/_/g, "/");
  const bytes = Uint8Array.from(atob(base64 + "=".repeat((4 - (base64.length % 4)) % 4)), (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function parts(part: MailPart | undefined): MailPart[] {
  if (!part) return [];
  return [part, ...(part.parts ?? []).flatMap(parts)];
}

/** Plain text through foxshield: each paragraph is a block, so a flagged one is marked on its own. */
export function shieldedText(text: string, sanitizeHtml: HtmlSanitizer): string {
  const blocks = text.replace(/\r\n/g, "\n").split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  return blocks.length ? sanitizeHtml(blocks.map((p) => `<p>${escape(p)}</p>`).join("")) : "";
}

/** The mail body the planner may read, and the part it came from. */
export function shieldedMailText(payload: MailPart | undefined, sanitizeHtml: HtmlSanitizer): { text: string; part: "html" | "plain" | "none" } {
  const all = parts(payload);
  const html = all.find((p) => p.mimeType === "text/html" && p.body?.data !== undefined);
  if (html?.body?.data !== undefined) return { text: sanitizeHtml(decode(html.body.data)), part: "html" };
  const plain = all.find((p) => p.mimeType === "text/plain" && p.body?.data !== undefined);
  if (plain?.body?.data !== undefined) return { text: shieldedText(decode(plain.body.data), sanitizeHtml), part: "plain" };
  return { text: "", part: "none" };
}
