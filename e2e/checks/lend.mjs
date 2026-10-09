// L1-L4: lend a login. The user signs in to a local bank in their own tab,
// lends it from the Lend view, foxmate sends money in the lent tab, the
// page's attempts to reach the attacker are blocked, and Revoke takes it
// all back while the user's own tab stays signed in.
import { saveShot } from "../lib.mjs";
import { startBank } from "../bank.mjs";

const wait = (ms) => new Promise((done) => setTimeout(done, ms));

export default async function lendCheck({ session, check, record, scripted, finish, runGoal }) {
  const { fox, sidebar } = session;
  const bank = await startBank();
  try {
    const own = await fox.open(`${bank.url}/login?user=sam`);
    check("L1 your own tab is signed in", "Signed in as sam", await own.evaluate(() => document.querySelector("h1").textContent));
    const lent = await sidebar.evaluate(async (url) => {
      window.foxmate.show("lend");
      document.getElementById("lend-url").value = url;
      document.getElementById("lend-scope").value = "submit";
      document.getElementById("lend-form").requestSubmit();
      for (let i = 0; i < 100 && !/^(Lent|Not lent)/.test(document.getElementById("lend-status").textContent); i++) await new Promise((r) => setTimeout(r, 100));
      const { loans } = await browser.runtime.sendMessage({ op: "loans" });
      return { status: document.getElementById("lend-status").textContent, loan: loans[0] };
    }, `${bank.url}/`);
    const loanTab = (await fox.browser.pages()).findLast((p) => p.url().startsWith(bank.url) && p !== own);
    await wait(500);
    check("L2 the lent tab opens signed in, in its own container", { status: true, heading: "Signed in as sam", container: true, copied: true },
      { status: lent.status.startsWith("Lent www.bank.localhost"), heading: await sidebar.evaluate(async (tabId) => (await browser.scripting.executeScript({ target: { tabId }, func: () => document.querySelector("h1")?.textContent }))[0]?.result, lent.loan?.tabId), container: lent.loan?.cookieStoreId?.startsWith("firefox-container-"), copied: lent.loan?.copied >= 1 });

    const run = await runGoal(session, {
      loanId: lent.loan.id, page: loanTab, goal: "Send $5 to Alex.", shot: "chat-lend",
      settings: scripted([
        { tool: "snapshot", args: {} },
        { tool: "click", args: { controlId: "{{control:link \"Transfer}}" } },
        { tool: "snapshot", args: {} },
        { tool: "act", args: { controlId: "{{control:\"To\"}}", op: "type", value: "Alex" } },
        { tool: "act", args: { controlId: "{{control:Amount}}", op: "type", value: "5" } },
        { tool: "click", args: { controlId: "{{control:Send money}}" } },
        finish,
      ]),
    });
    await wait(1000);
    record.runs.lend = { status: run.status, steps: run.steps, attacker: bank.log.attacker };
    check("L3 foxmate sends the money in the lent tab, with the lent session", { done: true, transfers: [{ user: "sam", to: "Alex", amount: "5" }] }, { done: run.done, transfers: bank.log.transfers });
    const blocked = await sidebar.evaluate(async () => {
      window.foxmate.show("lend");
      await new Promise((r) => setTimeout(r, 500));
      return { rows: [...document.querySelectorAll("#blocked li")].map((li) => li.textContent).filter((t) => t.includes("attacker.test")).length };
    });
    await saveShot(sidebar, "lend");
    const trail = await sidebar.evaluate(() => browser.runtime.sendMessage({ op: "trail" }));
    check("L3 the page's requests to the attacker are blocked and logged", { attacker: [], shown: true, trail: true },
      { attacker: bank.log.attacker, shown: blocked.rows >= 1, trail: trail.entries.some((e) => e.kind === "lend.blocked" && e.data.url.includes("attacker.test")) });

    const revoked = await sidebar.evaluate(async () => {
      document.querySelector('#loans button[data-action="revoke"]').click();
      for (let i = 0; i < 100 && !document.getElementById("lend-status").textContent.startsWith("Revoked"); i++) await new Promise((r) => setTimeout(r, 100));
      const { loans } = await browser.runtime.sendMessage({ op: "loans" });
      const containers = (await browser.contextualIdentities.query({})).filter((c) => c.name.startsWith("Agent"));
      window.foxmate.show("chat");
      return { status: document.getElementById("lend-status").textContent, loans: loans.length, containers: containers.length };
    });
    await own.reload();
    check("L4 Revoke removes the loan and its container; your own tab stays signed in", { status: "Revoked. The container and its cookies are gone.", loans: 0, containers: 0, own: "Signed in as sam" },
      { ...revoked, own: await own.evaluate(() => document.querySelector("h1").textContent) });
  } finally {
    await bank.close();
  }
}
