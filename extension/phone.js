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
}

export const phone = {
  init(p) {
    port = p;
    $("module-phone").addEventListener("change", async () => {
      const { settings = {} } = await browser.storage.local.get("settings");
      await browser.storage.local.set({ settings: { ...settings, modules: { ...settings.modules, phone: $("module-phone").checked } } });
      if (!$("module-phone").checked) {
        link?.close();
        link = undefined;
        $("phone-status").textContent = "Not paired.";
      }
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
    render();
  },
  shown: render,
  message(message) {
    const event = message.event;
    if (!link || event?.type !== "approval-needed") return;
    askApproval(link, { title: `foxmate asks: ${event.detail ?? `${event.action.tool} on ${event.action.domain}`}`, detail: event.exactText ?? JSON.stringify(event.action) }, { timeoutMs: Math.max(1000, event.expiresAt - Date.now()) })
      .then((answer) => port.postMessage({ op: "answer", requestId: event.requestId, answer, via: "phone" }))
      .catch(() => undefined);
  },
};
