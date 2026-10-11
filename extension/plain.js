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
