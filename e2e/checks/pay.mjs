// PY1-PY12 (pay): a bill page and its x402 address on a local server. The
// address is foxpay's fake paid API, so there is no chain and no money. The
// user sets the cap, the payee and the wallet in Settings, then approves.
import { createServer } from "node:http";
import { poll } from "create-foxkit/e2e";
import { fakeX402Api } from "foxpay-agent/testing";
import { saveShot } from "../lib.mjs";

// A Base Sepolia test key and recipient, from foxpay's README.
const WALLET = "0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318";
const PAY_TO = "0x209693Bc6afc0C5328bA36FaF03C514EF312287C";
const results = (run) => run.trail.filter((e) => e.kind === "loop.tool-result" && e.data.name === "pay").map((e) => e.data.summary);

export default async function payCheck({ session, check, record, scripted, finish, runGoal }) {
  const { sidebar } = session;
  let api;
  const server = createServer(async (req, res) => {
    if (req.url === "/bill") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(`<!doctype html><title>Water bill 42</title><main><h1>Water bill 42</h1><p>Amount due: ${api.price / 1e6} USDC</p><a href="/pay/42">Pay</a></main>`);
      return;
    }
    const headers = Object.fromEntries(Object.entries(req.headers).filter(([, v]) => typeof v === "string"));
    const answer = await api.handle(new Request(`http://${req.headers.host}${req.url}`, { headers }));
    res.writeHead(answer.status, Object.fromEntries(answer.headers));
    res.end(await answer.text());
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const base = `http://127.0.0.1:${server.address().port}`;
  api = fakeX402Api({ host: `127.0.0.1:${server.address().port}`, protocol: "http:", payTo: PAY_TO, price: 10_000, body: "Water bill 42 is paid." });
  const payStep = (amount, path = "/pay/42") => ({ tool: "pay", args: { url: `${base}${path}`, amount, reason: "Water bill 42" } });
  // The settings that the sidebar saved, with a script for this run.
  const withScript = async (steps) => ({ ...(await sidebar.evaluate(async () => (await browser.storage.local.get("settings")).settings ?? {})), ...scripted(steps) });
  try {
    const off = await runGoal(session, { url: `${base}/bill`, goal: "Pay this bill.", settings: scripted([payStep("0.01"), finish, finish]) });
    check("PY1 with no cap (the default), the pay tool refuses, and the pay address sees nothing", { result: ["Payments are off. The user can set a spending cap in Settings."], requests: 0 },
      { result: results(off), requests: api.log.filter((l) => l.path.startsWith("/pay")).length });

    // The user sets the cap, the payee and the wallet in Settings.
    const status = await sidebar.evaluate(async (payee, key) => {
      window.foxmate.show("settings");
      for (const [id, value] of [["pay-cap", "0.05"], ["pay-payees", `127.0.0.1 ${payee}`]]) {
        document.getElementById(id).value = value;
        document.getElementById(id).dispatchEvent(new Event("change", { bubbles: true }));
      }
      await new Promise((r) => setTimeout(r, 300));
      document.getElementById("pay-wallet").value = key;
      document.getElementById("save-wallet").click();
    }, PAY_TO, WALLET).then(() => poll(sidebar, () => (/foxvault, for/.test(document.getElementById("pay-status").textContent) ? document.getElementById("pay-status").textContent : null)));
    await saveShot(sidebar, "settings-pay");
    await sidebar.evaluate(() => window.foxmate.show("chat"));
    check("PY12 Settings saves the wallet in foxvault for the payee's site", "The wallet is in foxvault, for payments to 127.0.0.1.", status);

    // PY3, PY5, PY6: one approval, one payment; the same payment asked again pays nothing.
    const paid = await runGoal(session, {
      url: `${base}/bill`, goal: "Pay this bill.", shot: "chat-pay",
      settings: await withScript([{ tool: "snapshot", args: {} }, payStep("0.01"), payStep("0.01"), { tool: "snapshot", args: {} }, finish]),
    });
    const asked = paid.approvals.map((a) => JSON.parse(a.text));
    record.runs.pay = { status: paid.status, approvals: paid.approvals, steps: paid.steps };
    check("PY3 the approval shows the exact amount, currency, payee and host", { tool: "foxpay.pay", amount: 10_000, currency: "USDC", payee: `${PAY_TO} on eip155:84532`, domain: "127.0.0.1", detail: `Pay 0.01 USDC to ${PAY_TO} on eip155:84532 on 127.0.0.1, for "Water bill 42".` },
      { tool: asked[0]?.tool, amount: asked[0]?.args.amount, currency: asked[0]?.args.currency, payee: asked[0]?.args.payee, domain: asked[0]?.domain, detail: paid.approvals[0]?.detail });
    check("PY5 PY6 approved once, paid once; the replay is refused and pays nothing", { done: true, approvals: 1, settled: 1, results: [`Paid 0.01 USDC to ${PAY_TO} on eip155:84532.`, "This payment already ran (paid). foxmate does not pay it again."] },
      { done: paid.done, approvals: paid.approvals.length, settled: api.settled.length, results: results(paid) });
    const receipt = paid.trail.find((e) => e.kind === "pay.result")?.data;
    const stored = await sidebar.evaluate(async () => JSON.stringify(await browser.storage.local.get(null)));
    check("PY9 PY12 the trail has the receipt; the wallet key is not in the trail or storage.local", { status: "paid", transaction: true, keyInTrail: false, keyInStorage: false },
      { status: receipt?.status, transaction: /^0x[0-9a-f]{64}$/.test(receipt?.proof?.transaction ?? ""), keyInTrail: JSON.stringify(paid.trail).includes(WALLET.slice(2)), keyInStorage: stored.includes(WALLET.slice(2)) });

    // PY2: the bill now asks for 1 USDC, over the 0.05 cap.
    api.price = 1_000_000;
    const over = await runGoal(session, { url: `${base}/bill`, goal: "Pay this bill.", settings: await withScript([{ tool: "snapshot", args: {} }, payStep("1", "/pay/43"), finish, finish]) });
    check("PY2 an over-cap payment is refused before any approval, and nothing is paid", { approvals: 0, settled: 1, refused: true },
      { approvals: over.approvals.length, settled: api.settled.length, refused: (results(over)[0] ?? "").startsWith("foxpay refused the payment (spend-cap)") });
  } finally {
    await new Promise((done) => server.close(done));
  }
}
