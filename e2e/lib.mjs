// Helpers for the E2E tests: the driver from cli/driver.mjs, and app page
// screenshots.
import { readFileSync, writeFileSync } from "node:fs";
import { runGoal as drive } from "../cli/driver.mjs";

export { readTrail, setSettings, startFox } from "../cli/driver.mjs";

/**
 * With FOXMATE_SHOTS=<dir>, saves the rendered app page as <dir>/<name>.html
 * with its CSS. BiDi cannot capture moz-extension: pages, so the screenshots
 * come from these files, served over http.
 */
export async function saveShot(sidebar, name) {
  const dir = process.env.FOXMATE_SHOTS;
  if (!dir || !name) return;
  const body = await sidebar.evaluate(() => {
    for (const area of document.querySelectorAll("textarea")) area.textContent = area.value;
    for (const input of document.querySelectorAll("input")) input.setAttribute("value", input.value);
    for (const box of document.querySelectorAll("input[type=checkbox], input[type=radio]")) box.toggleAttribute("checked", box.checked);
    for (const select of document.querySelectorAll("select")) for (const o of select.options) o.toggleAttribute("selected", o.selected);
    return document.body.innerHTML;
  });
  writeFileSync(`${dir}/${name}.html`, `<!doctype html><meta charset="utf-8"><style>${readFileSync("extension/app.css", "utf8")}</style><body>${body}</body>`);
}

/** runGoal from cli/driver.mjs, with `shot` to save the sidebar at the end. */
export const runGoal = (session, { shot, ...options }) => drive(session, { ...options, onEnd: (sidebar) => saveShot(sidebar, shot) });
