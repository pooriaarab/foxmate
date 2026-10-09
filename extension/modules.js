// The screenshot (foxlens) and Google (foxlink) switches in Settings. Both
// are off by default. The settings live in settings.modules.
const $ = (id) => document.getElementById(id);
const FIELDS = { "module-lens": "lens", "module-google": "google", "lens-model": "lensModel", "lens-url": "lensURL", "google-client": "googleClientId" };

async function read() {
  const { settings = {} } = await browser.storage.local.get("settings");
  return settings;
}

async function render() {
  const { modules = {} } = await read();
  for (const [id, key] of Object.entries(FIELDS)) {
    if ($(id).type === "checkbox") $(id).checked = Boolean(modules[key]);
    else $(id).value = modules[key] ?? "";
  }
  $("lens-panel").hidden = !modules.lens;
  $("google-panel").hidden = !modules.google;
}

async function save() {
  const settings = await read();
  const next = { ...settings.modules };
  for (const [id, key] of Object.entries(FIELDS)) next[key] = $(id).type === "checkbox" ? $(id).checked : $(id).value.trim();
  await browser.storage.local.set({ settings: { ...settings, modules: next } });
  await render();
}

export const modules = {
  init() {
    for (const id of Object.keys(FIELDS)) $(id).addEventListener("change", save);
    $("google-connect").addEventListener("click", async () => {
      // Ask at the click for Firefox's consent for mail and sign-in data.
      const granted = await browser.permissions.request({ data_collection: ["personalCommunications", "authenticationInfo"] }).catch(() => false);
      if (!granted) {
        $("google-status").textContent = "Firefox did not allow it.";
        return;
      }
      const answer = await browser.runtime.sendMessage({ op: "google-connect" });
      $("google-status").textContent = answer.error ? `Not connected: ${answer.error}` : "Connected. read_calendar and read_inbox can run.";
    });
    browser.storage.onChanged.addListener((changes, area) => {
      if (area === "local" && changes.settings) render();
    });
    render();
  },
};
