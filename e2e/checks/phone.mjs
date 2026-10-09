// F1-F2: phone approvals (foxsync). A second Firefox plays the phone. It
// pairs with the sidebar, gets each approval with the exact action, and its
// answer decides the run. The sidebar buttons are not used.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launch, poll, serve } from "create-foxkit/e2e";
import { build } from "esbuild";
import { saveShot } from "../lib.mjs";

export const PHONE_PREFS = { "media.peerconnection.ice.obfuscate_host_addresses": false };

export default async function phoneCheck({ session, check, record, scripted, finish, runGoal }) {
  const { sidebar } = session;
  const dir = mkdtempSync(join(tmpdir(), "foxmate-phone-"));
  await build({ entryPoints: ["e2e/phone/phone.js"], bundle: true, format: "iife", outfile: join(dir, "phone.js"), logLevel: "warning" });
  writeFileSync(join(dir, "index.html"), '<!doctype html><meta charset="utf-8"><title>Test phone</title><script src="phone.js"></script>');
  const phoneSite = await serve(dir);
  const site = await serve("e2e/site");
  const phoneFox = await launch({ extension: "dist-ext", headless: session.headless, prefs: PHONE_PREFS });
  try {
    const phone = await phoneFox.open(`${phoneSite.url}/index.html`);
    const offer = await sidebar.evaluate(async () => {
      window.foxmate.show("settings");
      const box = document.getElementById("module-phone");
      if (!box.checked) box.click();
      for (let i = 0; i < 20 && document.getElementById("phone-panel").hidden; i++) await new Promise((r) => setTimeout(r, 100));
      document.getElementById("phone-pair").click();
      for (let i = 0; i < 100 && !document.getElementById("phone-offer").value; i++) await new Promise((r) => setTimeout(r, 100));
      return document.getElementById("phone-offer").value;
    });
    const answer = await phone.evaluate((text) => window.phone.pair(text), offer);
    const status = await sidebar.evaluate(async (a) => {
      document.getElementById("phone-answer").value = a;
      document.getElementById("phone-connect").click();
      for (let i = 0; i < 300 && !/^(Paired|Not paired)/.test(document.getElementById("phone-status").textContent); i++) await new Promise((r) => setTimeout(r, 100));
      return document.getElementById("phone-status").textContent;
    }, answer);
    await poll(phone, () => window.phone.paired === true, undefined, 30_000);
    await saveShot(sidebar, "settings-phone");
    await sidebar.evaluate(() => window.foxmate.show("chat"));
    check("F1 the sidebar pairs with the phone", "Paired. Approvals go to the phone too.", status);

    const book = (decision, name) => phone.evaluate((d) => { window.phone.decision = d; }, decision).then(() => runGoal(session, {
      url: `${site.url}/table.html`, goal: `Book a table for ${name}.`, answer: () => "wait",
      settings: { ...scripted([{ tool: "snapshot", args: {} }, { tool: "browser_task", args: { goal: `name: ${name}, party size: 2` } }, finish]), modules: { phone: true } },
    }));
    const yes = await book("approve", "Ana Silva");
    const no = await book("deny", "Lee Wong");
    const requests = await phone.evaluate(() => window.phone.requests);
    record.runs.phone = { requests, yes: yes.status, no: no.status };
    check("F2 the phone gets the exact action, and its answer decides", { first: true, exact: true, yes: true, no: "Blocked (approval-denied)", via: ["phone", "phone"] }, {
      first: requests[0]?.title.includes("name: Ana Silva, party size: 2"),
      exact: Boolean(requests[0]?.detail) && yes.steps.some((s) => s.includes(requests[0].detail)),
      yes: yes.done && new URL(yes.url).searchParams.get("name") === "Ana Silva",
      no: no.status.slice(0, 25),
      via: [...yes.trail, ...no.trail].filter((e) => e.kind === "approval.answer").map((e) => e.data.via),
    });
  } finally {
    await phoneFox.close();
    await phoneSite.close();
    await site.close();
  }
}
