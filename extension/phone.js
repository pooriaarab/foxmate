// Phone approvals (foxsync), off by default. The desktop end of the link
// lives in this sidebar: WebRTC in the background page would die when the
// page unloads. Each approval goes to the phone with the exact action, and
// the first answer, from the phone or the sidebar, decides.
import { askApproval, pairDesktop } from "foxsync";

const $ = (id) => document.getElementById(id);
let port;
let pairing;
let link;

async function enabled() {
  const { settings = {} } = await browser.storage.local.get("settings");
  return Boolean(settings.modules?.phone);
}

async function render() {
  const on = await enabled();
  $("module-phone").checked = on;
  $("phone-panel").hidden = !on;
  if (!on && link) {
    // Turned off, also from another view: no approval goes to the phone.
    link.close();
    link = undefined;
    $("phone-status").textContent = "Not paired.";
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
    $("phone-pair").addEventListener("click", async () => {
      pairing?.cancel();
      pairing = await pairDesktop({ name: "foxmate" });
      $("phone-offer").value = pairing.qr ?? `${pairing.code}\n${pairing.offer}`;
      $("phone-status").textContent = `Code ${pairing.code}. Check that the phone shows the same code.`;
    });
    $("phone-connect").addEventListener("click", async () => {
      try {
        link = await pairing.waitForPhone($("phone-answer").value.trim());
        $("phone-status").textContent = "Paired. Approvals go to the phone too.";
        link.closed.then(() => {
          link = undefined;
          $("phone-status").textContent = "The phone link closed.";
        });
      } catch (error) {
        $("phone-status").textContent = `Not paired: ${error.message}`;
      }
    });
    browser.storage.onChanged.addListener((changes, area) => {
      if (area === "local" && changes.settings) render();
    });
    render();
  },
  shown: render,
  message(message) {
    // A sidebar that opens late gets the run's events at once; their approvals go to the phone too.
    for (const event of [...(message.events ?? []), ...(message.event ? [message.event] : [])]) ask(event);
  },
};

function ask(event) {
  if (!link || event?.type !== "approval-needed" || event.expiresAt < Date.now()) return;
  askApproval(link, { title: `foxmate asks: ${event.detail ?? `${event.action.tool} on ${event.action.domain}`}`, detail: event.exactText ?? JSON.stringify(event.action) }, { timeoutMs: Math.max(1000, event.expiresAt - Date.now()) })
    .then((answer) => port.postMessage({ op: "answer", requestId: event.requestId, answer, via: "phone" }))
    .catch(() => undefined);
}
