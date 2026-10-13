// F1-F3: phone approvals (foxsync). A second Firefox plays the phone. The
// test reads the QR code that Settings draws, and the phone opens that URL:
// foxsync's hosted phone page. The phone presses Pair, its answer goes
// through the hosted relay, and the sidebar links with no copy step. Each
// approval shows on the phone with the exact action, and the phone's tap
// decides the run. The sidebar buttons are not used.
import { launch, poll, serve } from "create-foxkit/e2e";
import jsQR from "jsqr";
import { PHONE_URL } from "../../extension/phone.js";
import { saveShot } from "../lib.mjs";

export const PHONE_PREFS = { "media.peerconnection.ice.obfuscate_host_addresses": false };

/** Decodes the QR code that Settings draws: its SVG squares become pixels, 4 per module. */
async function readQr(sidebar) {
  const { size, d } = await sidebar.evaluate(() => {
    const svg = document.getElementById("phone-qr");
    return { size: svg.viewBox.baseVal.width, d: svg.querySelector("path").getAttribute("d") };
  });
  const k = 4;
  const width = size * k;
  const pixels = new Uint8ClampedArray(width * width * 4).fill(255);
  for (const [, x, y] of d.matchAll(/M(\d+) (\d+)/g)) {
    for (let row = Number(y) * k; row < (Number(y) + 1) * k; row++) {
      for (let col = Number(x) * k; col < (Number(x) + 1) * k; col++) pixels.fill(0, (row * width + col) * 4, (row * width + col) * 4 + 3);
    }
  }
  return jsQR(pixels, width, width)?.data ?? "";
}

/** With FOXMATE_SHOTS=<dir>, saves the phone page as <dir>/<name>.png. */
const phoneShot = (phone, name) => process.env.FOXMATE_SHOTS && phone.screenshot({ path: `${process.env.FOXMATE_SHOTS}/${name}.png` });

/** The requests that the phone page shows, oldest first. */
const shownRequests = (phone) => phone.evaluate(() => [...document.querySelectorAll("#feed li.request")].toReversed().map((li) => ({ title: li.querySelector(".title").textContent, detail: li.querySelector(".detail").textContent })));

export default async function phoneCheck({ session, check, record, scripted, finish, runGoal }) {
  const { sidebar } = session;
  const site = await serve("e2e/site");
  const phoneFox = await launch({ extension: "dist-ext", headless: session.headless, prefs: PHONE_PREFS });
  try {
    const desk = await sidebar.evaluate(async () => {
      window.foxmate.show("settings");
      const box = document.getElementById("module-phone");
      if (!box.checked) box.click();
      for (let i = 0; i < 20 && document.getElementById("phone-panel").hidden; i++) await new Promise((r) => setTimeout(r, 100));
      document.getElementById("phone-pair").click();
      for (let i = 0; i < 100 && document.getElementById("phone-show").hidden; i++) await new Promise((r) => setTimeout(r, 100));
      return { code: document.getElementById("phone-code").textContent, boxes: document.querySelectorAll("#phone-panel textarea").length };
    });
    await saveShot(sidebar, "settings-phone-qr");
    const url = await readQr(sidebar);
    const phone = await phoneFox.open(url);
    await phone.setViewport({ width: 390, height: 844 });
    const asked = await poll(phone, () => !document.getElementById("confirm-box").hidden && document.getElementById("confirm-code").textContent);
    await phoneShot(phone, "phone-confirm");
    await phone.evaluate(() => document.getElementById("confirm-pair").click());
    const status = await poll(sidebar, () => /^(Paired|Not paired)/.test(document.getElementById("phone-status").textContent) && document.getElementById("phone-status").textContent, undefined, 60_000);
    const linked = await poll(phone, () => document.getElementById("state").textContent.startsWith("linked") && document.getElementById("state").textContent, undefined, 30_000);
    await saveShot(sidebar, "settings-phone");
    await sidebar.evaluate(() => window.foxmate.show("chat"));
    check("F1 the QR code opens the hosted phone page, and the sidebar links through the relay", {
      url: true, code: desk.code, boxes: 0, status: "Paired. Approvals go to the phone too.", linked: "linked to foxmate",
    }, { url: url.startsWith(`${PHONE_URL}#fsy1.q.`), code: asked, boxes: desk.boxes, status, linked });

    // The phone's user taps the button that window.tap names on each new request.
    await phone.evaluate(() => {
      new MutationObserver(() => {
        for (const button of document.querySelectorAll(`#feed button[data-decision="${window.tap}"]`)) button.click();
      }).observe(document.getElementById("feed"), { childList: true, subtree: true });
    });
    const book = (decision, name) => phone.evaluate((d) => { window.tap = d; }, decision).then(() => runGoal(session, {
      url: `${site.url}/table.html`, goal: `Book a table for ${name}.`, answer: () => "wait",
      settings: { ...scripted([{ tool: "snapshot", args: {} }, { tool: "browser_task", args: { goal: `name: ${name}, party size: 2` } }, finish]), modules: { phone: true } },
    }));
    const yes = await book("approve", "Ana Silva");
    const no = await book("deny", "Lee Wong");
    const requests = await shownRequests(phone);
    await phoneShot(phone, "phone-requests");
    record.runs.phone = { url: url.split("#")[0], requests, yes: yes.status, no: no.status };
    check("F2 the phone gets the exact action, and its answer decides", { first: true, exact: true, yes: true, no: "Blocked (approval-denied)", via: ["phone", "phone"] }, {
      // The phone leads with the exact action that foxgate allows; the planner's words come after.
      // The title names where the form sends (UI11).
      first: /^foxmate asks: browser_task on 127\.0\.0\.1, sends to 127\.0\.0\.1:\d+\//.test(requests[0]?.title ?? "") && requests[0]?.detail.includes("foxmate says: let foxpaw fill the form") && requests[0]?.detail.includes("name: Ana Silva, party size: 2"),
      exact: Boolean(requests[0]?.detail) && yes.steps.some((s) => s.includes(requests[0].detail.split("\n\n")[0])),
      yes: yes.done && new URL(yes.url).searchParams.get("name") === "Ana Silva",
      no: no.status.slice(0, 25),
      via: [...yes.trail, ...no.trail].filter((e) => e.kind === "approval.answer").map((e) => e.data.via),
    });

    // F3 (G33): one reply with two fills. The memory check saved a note on tables, so this run
    // holds private data and each fill asks (G17). The phone gets one request per call, in order.
    const seen = requests.length;
    await phone.evaluate(() => { window.tap = "approve"; });
    const batch = await runGoal(session, {
      url: `${site.url}/table.html`, goal: "Book a table for Kim Park at Bistro Lune.", answer: () => "wait",
      settings: { ...scripted([{ batch: [{ tool: "act", args: { controlId: "{{control:Name}}", op: "type", value: "Kim Park" } }, { tool: "act", args: { controlId: "{{control:Party size}}", op: "select", value: "3" } }] }, { tool: "click", args: { controlId: "{{control:Book a table}}" } }, finish]), modules: { phone: true } },
    });
    const later = (await shownRequests(phone)).slice(seen);
    record.runs.phoneBatch = { asked: later, steps: batch.steps };
    check("F3 two calls in one reply ask the phone one at a time, in order", { tools: ["act", "act", "click"], values: ["Kim Park", "3"], cards: 3, done: true, booked: "Kim Park/3" }, {
      tools: later.map((r) => r.title.split(" ")[2]),
      values: later.slice(0, 2).map((r) => JSON.parse(r.detail.split("\n\n")[0]).args.value),
      cards: batch.trail.filter((e) => e.kind === "approval.answer" && e.data.via === "phone").length,
      done: batch.done,
      booked: `${new URL(batch.url).searchParams.get("name")}/${new URL(batch.url).searchParams.get("party")}`,
    });
  } finally {
    await phoneFox.close();
    await site.close();
  }
}
