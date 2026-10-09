// S1-S3 (space): drop a CSV in the Space view, ask in Chat, and the planner's
// Python sums it in the sandbox. The same Python cannot reach the network.
import { createServer } from "node:http";
import { serve, poll } from "create-foxkit/e2e";
import { saveShot } from "../lib.mjs";

export default async function spaceCheck({ session, check, record, scripted, finish, runGoal }) {
  const { sidebar } = session;
  // BiDi cannot set files on a moz-extension: page, so the test hands the file
  // input a File as a drop would, and the view's own change handler runs.
  await sidebar.evaluate(() => {
    window.foxmate.show("space");
    const input = document.getElementById("space-files");
    const drop = new DataTransfer();
    drop.items.add(new File(["region,amount\nnorth,10\nsouth,20\nwest,12.5\n"], "sales.csv", { type: "text/csv" }));
    input.files = drop.files;
    input.dispatchEvent(new Event("change"));
  });
  const listed = await poll(sidebar, () => [...document.querySelectorAll("#space-list li")].map((li) => li.dataset.path).join(",") || null, undefined, 60_000);
  await saveShot(sidebar, "space");
  await sidebar.evaluate(() => window.foxmate.show("chat"));
  check("DS1 the Space view adds a dropped file to /drop", "/drop/sales.csv", listed);

  const site = await serve("e2e/site");
  try {
    const sum = await runGoal(session, {
      url: `${site.url}/table.html`, goal: "Sum the amount column of sales.csv.", shot: "chat-space",
      settings: scripted([{ tool: "run_python", args: { code: "import csv\nrows = list(csv.DictReader(open('/drop/sales.csv')))\nsum(float(r['amount']) for r in rows)" } }, finish]),
    });
    record.runs.space = { status: sum.status, steps: sum.steps };
    check("DS2 the planner's Python sums the file, and the run is done", { done: true, result: true, grant: true },
      { done: sum.done, result: sum.trail.some((e) => e.kind === "loop.tool-result" && e.data.name === "run_python" && e.data.ok), grant: sum.trail.some((e) => e.kind === "loop.decision" && e.data.action?.domain === "space.foxmate" && e.data.decision === "allow") });
    // A probe server counts every request that reaches it.
    let hits = 0;
    const probe = createServer((_req, res) => { hits += 1; res.end("ok"); });
    await new Promise((done) => probe.listen(0, "127.0.0.1", done));
    const probeUrl = `http://127.0.0.1:${probe.address().port}/`;
    // The positive case first: a request from outside the Space reaches the probe.
    await fetch(probeUrl);
    const seen = hits;
    hits = 0;
    const net = await runGoal(session, {
      url: `${site.url}/table.html`, goal: "Fetch a page from Python.",
      settings: scripted([{ tool: "run_python", args: { code: `from js import XMLHttpRequest\nx = XMLHttpRequest.new()\nx.open("GET", "${probeUrl}", False)\nx.send()\nx.status` } }, finish, finish]),
    });
    // DS4 (G16): after Python read a private file, a page asks to put its data in an
    // open_url query on the same host. Before the fix this ran with no approval.
    hits = 0;
    const leak = await runGoal(session, {
      url: `${site.url}/table.html`, goal: "Sum the amount column of sales.csv.", answer: () => "deny", shot: "chat-private",
      settings: scripted([
        { tool: "run_python", args: { code: "open('/drop/sales.csv').read().splitlines()[1]" } },
        { tool: "open_url", args: { url: `${probeUrl}log?d=north,10` } },
        finish,
      ]),
    });
    record.runs.spaceLeak = { status: leak.status, steps: leak.steps, approvals: leak.approvals };
    check("DS4 after private data, open_url on the tab's host asks first; denied, nothing leaves", { private: true, asked: ["open_url"], status: "Blocked (approval-denied)", hits: 0 },
      { private: leak.trail.some((e) => e.kind === "run.private"), asked: leak.approvals.map((a) => JSON.parse(a.text).tool), status: leak.status.slice(0, 25), hits });
    await new Promise((done) => probe.close(done));
    record.runs.spaceNetwork = { status: net.status, steps: net.steps, probeHits: hits };
    check("DS3 Python in the Space cannot reach the network, and the check fails", { seen: 1, failed: true, done: false, hits: 0 },
      { seen, failed: net.trail.some((e) => e.kind === "loop.tool-result" && e.data.name === "run_python" && !e.data.ok), done: net.done, hits });
  } finally {
    await site.close();
  }
}
