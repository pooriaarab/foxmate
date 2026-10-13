// Plain words for a tool call, for the approval card and the step list.
// The raw call (tool name and JSON arguments) stays behind "Details".

const on = (domain) => (domain ? ` on ${domain}` : "");
const quoted = (label) => (typeof label === "string" && label.trim() ? ` "${label.trim().slice(0, 60)}"` : "");
const hostOfUrl = (url) => {
  try {
    return new URL(String(url)).hostname;
  } catch {
    return "";
  }
};
const ACT = { type: "Type in", select: "Pick an option in", check: "Tick", uncheck: "Clear", date: "Set a date in", scroll: "Scroll" };

/** What a tool call does, in plain words. `args` may be a JSON string (a plan) or an object (an approval). */
export function plain({ tool, args, domain }) {
  let a = args ?? {};
  if (typeof a === "string") {
    try {
      a = JSON.parse(a);
    } catch {
      a = {};
    }
  }
  const label = quoted(a.target?.label);
  switch (tool) {
    case "snapshot": return "Read the page";
    case "look": return "Look at the page";
    case "click": return `Click${label || " a button"}${on(domain)}`;
    case "act": return `${ACT[a.op] ?? "Change"}${label || " a field"}${on(domain)}`;
    case "open_url": return `Open ${hostOfUrl(a.url) || "a page"}`;
    case "open_site": return `Open ${hostOfUrl(a.url) || "a site"} in a new tab`;
    case "browser_task": return `Fill in and send the form${on(domain)}`;
    case "pay": return `Pay${on(domain)}`;
    case "run_python": return "Run a short Python program";
    case "read_inbox": return "Read your mail for this goal";
    case "read_calendar": return "Read your calendar for this goal";
    case "foxvault.fill": return `Fill your saved login${on(domain)}`;
    case "finish": return "Finish";
    default: return `Use ${String(tool).replaceAll("_", " ")}${on(domain)}`;
  }
}

/** A closed "Details" disclosure that holds raw text. */
export function details(text, caption) {
  const box = document.createElement("details");
  box.className = "raw";
  const summary = document.createElement("summary");
  summary.textContent = "Details";
  box.append(summary);
  if (caption) {
    const p = document.createElement("p");
    p.className = "caption";
    p.textContent = caption;
    box.append(p);
  }
  const pre = document.createElement("pre");
  pre.textContent = text;
  box.append(pre);
  return box;
}

// A form fill's approval: foxloop's browser_task puts foxpaw's preview of
// the form in action.args.form (foxloop G16, docs/failure-modes.md UI10, UI11).
const MAX_PART = 60;
const cut = (text) => {
  const s = String(text ?? "").replace(/\s+/g, " ").trim();
  return s.length > MAX_PART ? `${s.slice(0, MAX_PART - 1)}…` : s;
};
const formOf = (action) => {
  if (action?.tool === "browser_task") return action.args?.form && typeof action.args.form === "object" ? action.args.form : undefined;
  // fill_and_send: the pinned button's destination and the call's own fields (UI12).
  if (action?.tool !== "fill_and_send" || !Array.isArray(action.args?.targets)) return undefined;
  const fields = action.args.targets.map((t) => ({ label: t?.label, value: t?.request?.op === "check" ? "checked" : t?.request?.op === "uncheck" ? "unchecked" : t?.request?.value }));
  return { sends: true, destination: action.args.sendTarget?.action ?? null, fields };
};

/** Where the form sends, as host and path: "shop.example/checkout/pay". Empty when it is not a web address. */
function destinationOf(form) {
  try {
    const url = new URL(String(form.destination));
    return /^https?:$/.test(url.protocol) ? `${url.host}${url.pathname}` : "";
  } catch {
    return "";
  }
}

/** "Sends to shop.example/checkout/pay" for a form fill that sends; "" for anything else. */
export function sendsTo(action) {
  const form = formOf(action);
  if (!form?.sends) return "";
  const to = form.destination ? destinationOf(form) : "";
  return to ? `Sends to ${to}` : "foxpaw found no destination, so nothing will be sent";
}

/** Each field that a form fill gives a value, as "Label: value". foxpaw masks sensitive values. */
export function fieldsOf(action) {
  const fields = formOf(action)?.fields;
  return Array.isArray(fields) ? fields.map((f) => `${cut(f?.label)}: ${cut(f?.value)}`) : [];
}

/** The phone's title and detail: the exact action first, then the fields, then foxmate's words. */
export function phoneApproval(event) {
  const exact = event.exactText ?? JSON.stringify(event.action);
  const to = sendsTo(event.action);
  const fields = fieldsOf(event.action);
  return {
    title: `foxmate asks: ${event.action.tool} on ${event.action.domain}${to ? `, ${to.charAt(0).toLowerCase()}${to.slice(1)}` : ""}`,
    detail: [exact, fields.length ? `Fields: ${fields.join("; ")}` : "", event.detail ? `foxmate says: ${event.detail}` : ""].filter(Boolean).join("\n\n"),
  };
}
