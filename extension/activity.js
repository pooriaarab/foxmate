// The Activity view: the foxtrail log, newest first, and whether it
// verifies. Export saves the log as JSONL; `npx foxtrail verify` checks a
// copy only with the key, which stays in this browser.
const $ = (id) => document.getElementById(id);

/** One line for an entry: what happened, in short. */
function summary({ kind, data = {} }) {
  if (kind === "run.start") return `Goal on ${data.domain}: ${data.goal}`;
  if (kind === "run.refused") return `Refused: ${data.reason}`;
  if (kind === "shield.scan") return data.withheld ? `foxshield withheld ${data.url}: ${data.withheld}` : `foxshield read ${data.url}: ${data.findings} findings${data.droppedControls?.length ? `, dropped ${data.droppedControls.join(", ")}` : ""}`;
  if (kind === "approval.answer") return `${data.decision === "approve" ? "Approved" : "Denied"} from the ${data.via}`;
  if (kind === "loop.tool-call") return `${data.name}(${JSON.stringify(data.args)})`;
  if (kind === "loop.decision") return `gate ${data.via} ${data.decision}${data.reason ? `: ${data.reason}` : ""}`;
  if (kind === "loop.tool-result") return `${data.name}: ${data.summary}`;
  if (kind === "loop.done") return `Done: ${data.summary}`;
  if (kind === "loop.blocked") return `Blocked: ${data.reason}`;
  return "";
}

async function load() {
  const { entries, verify } = await browser.runtime.sendMessage({ op: "trail" });
  $("trail-status").textContent = verify.ok ? `The log verifies: ${verify.count} entries.` : `The log does not verify at entry ${verify.index}: ${verify.reason}.`;
  $("trail-status").className = verify.ok ? "muted" : "end bad";
  $("trail").replaceChildren(...entries.toReversed().slice(0, 300).map((entry) => {
    const li = document.createElement("li");
    li.dataset.kind = entry.kind;
    const time = document.createElement("span");
    time.className = "muted";
    time.textContent = `${new Date(entry.ts).toLocaleTimeString()} `;
    const kind = document.createElement("span");
    kind.className = "kind";
    kind.textContent = entry.kind;
    li.append(time, kind, document.createTextNode(summary(entry)));
    return li;
  }));
}

export const activity = {
  init() {
    $("trail-export").addEventListener("click", async () => {
      const { jsonl } = await browser.runtime.sendMessage({ op: "trail-export" });
      const link = document.createElement("a");
      link.href = URL.createObjectURL(new Blob([jsonl], { type: "application/jsonl" }));
      link.download = `foxmate-trail-${new Date().toISOString().slice(0, 10)}.jsonl`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(link.href), 1000);
    });
  },
  shown: load,
  message(message) {
    if (message.end && !$("trail").closest("section").hidden) load();
  },
};
