// The Notices part of Settings: quiet hours and an optional webhook, both
// off by default. The fields save settings.notices only (NT7). The preview
// is foxnotify's own request for these options (NT6). The goal goes in the
// webhook only after Firefox's websiteActivity consent (NT5).
import { previewWebhook } from "foxnotify";

const $ = (id) => document.getElementById(id);
const FIELDS = { "notice-quiet": "quiet", "notice-quiet-start": "quietStart", "notice-quiet-end": "quietEnd", "notice-webhook-url": "webhookURL", "notice-webhook": "webhook", "notice-title": "webhookTitle" };

async function read() {
  return (await browser.storage.local.get("settings")).settings ?? {};
}

function preview(n) {
  try {
    const request = previewWebhook({ url: n.webhookURL, includeTitle: Boolean(n.webhookTitle) });
    // A JSON body shows as an object, so a person can read it.
    $("notice-preview").textContent = JSON.stringify({ ...request, body: JSON.parse(request.body) }, null, 1);
  } catch (error) {
    $("notice-preview").textContent = n.webhookURL ? error.message : "Type an address to see the request.";
  }
}

async function render() {
  const n = (await read()).notices ?? {};
  for (const [id, key] of Object.entries(FIELDS)) {
    if ($(id).type === "checkbox") $(id).checked = Boolean(n[key]);
    else if (n[key]) $(id).value = n[key];
  }
  preview(n);
}

async function save() {
  const settings = await read();
  const notices = Object.fromEntries(Object.entries(FIELDS).map(([id, key]) => [key, $(id).type === "checkbox" ? $(id).checked : $(id).value.trim()]));
  await browser.storage.local.set({ settings: { ...settings, notices } });
  preview(notices);
}

export const notices = {
  init() {
    for (const id of Object.keys(FIELDS)) if (id !== "notice-title") $(id).addEventListener("change", save);
    $("notice-title").addEventListener("click", async () => {
      // Firefox's own consent prompt. An error counts as no.
      if ($("notice-title").checked && !(await browser.permissions.request({ data_collection: ["websiteActivity"] }).catch(() => false))) $("notice-title").checked = false;
      await save();
    });
    browser.storage.onChanged.addListener((changes, area) => {
      if (area === "local" && changes.settings) render();
    });
    render();
  },
};
