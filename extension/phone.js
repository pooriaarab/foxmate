// Phone approvals (foxsync), off by default. The desktop end of the link
// lives in this page: WebRTC in the background page would die when the
// page unloads. Each approval goes to the phone with the exact action, and
// the first answer, from the phone or the sidebar, decides.
//
// Pairing: the QR code opens foxsync's hosted phone page with the pairing
// text in the URL fragment, which never goes to a server. The phone posts
// its sealed answer to the relay, and this page picks it up, so nobody
// copies text by hand. The relay only sees sealed text.
import { askApproval, pairDesktop } from "foxsync";
import { encode } from "uqr";
import { phoneApproval } from "./plain.js";

export const PHONE_URL = "https://foxsync-phone.hello-fd1.workers.dev/";
export const RELAY_URL = "https://foxsync-relay.hello-fd1.workers.dev";
const SVG = "http://www.w3.org/2000/svg";

const $ = (id) => document.getElementById(id);
let port;
let pairing;
let link;
let starts = 0;

async function enabled() {
  const { settings = {} } = await browser.storage.local.get("settings");
  return Boolean(settings.modules?.phone);
}

async function render() {
  const on = await enabled();
  $("module-phone").checked = on;
  $("phone-panel").hidden = !on;
  if (!on) starts++; // a pairing that is still starting must not go on
  if (!on && (link || pairing)) {
    // Turned off, also from another view: no approval goes to the phone.
    pairing?.cancel();
    pairing = undefined;
    link?.close();
    link = undefined;
    $("phone-show").hidden = true;
    $("phone-status").textContent = "Not paired.";
  }
}

/** Draws the QR text as one SVG path: one square for each dark module. */
function drawQr(text) {
  const { data, size } = encode(text, { ecc: "L", border: 2 });
  const svg = $("phone-qr");
  // A whole number of pixels per module keeps the edges sharp for a camera.
  const side = size * Math.max(2, Math.floor(400 / size));
  svg.setAttribute("viewBox", `0 0 ${size} ${size}`);
  svg.setAttribute("width", String(side));
  svg.setAttribute("height", String(side));
  const back = document.createElementNS(SVG, "rect");
  back.setAttribute("width", String(size));
  back.setAttribute("height", String(size));
  back.setAttribute("fill", "#fff");
  const dark = document.createElementNS(SVG, "path");
  dark.setAttribute("d", data.flatMap((row, y) => row.map((on, x) => (on ? `M${x} ${y}h1v1h-1z` : ""))).join(""));
  svg.replaceChildren(back, dark);
}

async function pair() {
  // Each press replaces the pairing before it. A press that a later press
  // overtook while pairDesktop ran drops its own pairing.
  const turn = ++starts;
  pairing?.cancel();
  pairing = undefined;
  link?.close();
  link = undefined;
  const current = await pairDesktop({ name: "foxmate", phoneUrl: PHONE_URL, relay: RELAY_URL });
  if (turn !== starts) return current.cancel();
  pairing = current;
  if (!current.qr) throw new Error("the pairing text is too long for a QR code");
  drawQr(current.qr);
  $("phone-code").textContent = current.code;
  $("phone-show").hidden = false;
  $("phone-status").textContent = "Waiting for the phone.";
  try {
    const next = await current.waitForPhone();
    if (pairing !== current) return next.close();
    pairing = undefined;
    link = next;
    $("phone-show").hidden = true;
    $("phone-status").textContent = "Paired. Approvals go to the phone too.";
    next.closed.then(() => {
      if (link !== next) return;
      link = undefined;
      $("phone-status").textContent = "The phone link closed.";
    });
  } catch (error) {
    if (pairing !== current) return;
    pairing = undefined;
    $("phone-show").hidden = true;
    $("phone-status").textContent = `Not paired: ${error.message}`;
  }
}

export const phone = {
  init(p) {
    port = p;
    $("module-phone").addEventListener("change", async () => {
      const { settings = {} } = await browser.storage.local.get("settings");
      await browser.storage.local.set({ settings: { ...settings, modules: { ...settings.modules, phone: $("module-phone").checked } } });
      await render();
    });
    $("phone-pair").addEventListener("click", () => {
      pair().catch((error) => {
        $("phone-status").textContent = `Not paired: ${error.message}`;
      });
    });
    browser.storage.onChanged.addListener((changes, area) => {
      if (area === "local" && changes.settings) render();
    });
    render();
  },
  shown: render,
  message(message) {
    // A page that opens late gets the run's events at once; their approvals go to the phone too.
    for (const event of [...(message.events ?? []), ...(message.event ? [message.event] : [])]) ask(event);
  },
};

function ask(event) {
  if (!link || event?.type !== "approval-needed" || event.expiresAt < Date.now()) return;
  // Lead with the exact action that foxgate will allow; a form fill's destination is in the title (UI11).
  askApproval(link, phoneApproval(event), { timeoutMs: Math.max(1000, event.expiresAt - Date.now()) })
    .then((answer) => port.postMessage({ op: "answer", requestId: event.requestId, answer, via: "phone" }))
    .catch(() => undefined);
}
