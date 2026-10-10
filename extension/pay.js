// Payments in Settings: the cap for each goal, the payee of each site and
// the wallet key. The cap and the payees live in settings.pay. The wallet
// key goes to foxvault in the background page; the sidebar never stores it.
const $ = (id) => document.getElementById(id);
let port;

async function read() {
  const { settings = {} } = await browser.storage.local.get("settings");
  return settings;
}

async function render() {
  const { pay = {} } = await read();
  $("pay-cap").value = pay.cap ?? "0";
  $("pay-payees").value = pay.payees ?? "";
}

async function save() {
  const settings = await read();
  await browser.storage.local.set({ settings: { ...settings, pay: { cap: $("pay-cap").value.trim() || "0", payees: $("pay-payees").value.trim() } } });
}

export const pay = {
  init(p) {
    port = p;
    for (const id of ["pay-cap", "pay-payees"]) $(id).addEventListener("change", save);
    $("save-wallet").addEventListener("click", () => {
      port.postMessage({ op: "set-wallet", key: $("pay-wallet").value });
      $("pay-wallet").value = "";
      $("pay-status").textContent = "Saving the wallet…";
    });
    browser.storage.onChanged.addListener((changes, area) => {
      if (area === "local" && changes.settings) render();
    });
    render();
  },
  message(message) {
    if (message.walletError) $("pay-status").textContent = `The wallet was not saved: ${message.walletError}`;
    if (message.walletSaved) $("pay-status").textContent = `The wallet is in foxvault, for payments to ${message.walletSaved}.`;
  },
};
