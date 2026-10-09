// V1: the Activity view shows the foxtrail log and that it verifies.
import { saveShot } from "../lib.mjs";

export default async function activityCheck({ session, check }) {
  const { sidebar } = session;
  const trail = await sidebar.evaluate(() => browser.runtime.sendMessage({ op: "trail" }));
  const shown = await sidebar.evaluate(async () => {
    window.foxmate.show("activity");
    for (let i = 0; i < 50 && !/verifies/.test(document.getElementById("trail-status").textContent); i++) await new Promise((r) => setTimeout(r, 100));
    return { status: document.getElementById("trail-status").textContent, rows: document.querySelectorAll("#trail li").length, kinds: [...new Set([...document.querySelectorAll("#trail li")].map((li) => li.dataset.kind))] };
  });
  await saveShot(sidebar, "activity");
  await sidebar.evaluate(() => window.foxmate.show("chat"));
  check("V1 Activity shows the log and that it verifies", { status: `The log verifies: ${trail.entries.length} entries.`, rows: Math.min(300, trail.entries.length) }, { status: shown.status, rows: shown.rows });
  check("V1 Activity lists runs, scans, approvals and refusals", true, ["run.start", "shield.scan", "approval.answer", "run.refused", "loop.blocked"].every((k) => shown.kinds.includes(k)));
}
