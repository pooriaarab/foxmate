// UI2-UI3: the app page. The target is a web tab, never the foxmate page.
// "open-app" (the toolbar button) brings the open app tab to the front.
import { serve, poll } from "create-foxkit/e2e";
import { saveShot } from "../lib.mjs";

export default async function appCheck({ session, check }) {
  const { sidebar, fox } = session;

  // UI2: with the app page in front, the target is the web tab used last, not foxmate.
  const site = await serve("e2e/site");
  try {
    const page = await fox.open(`${site.url}/table.html`);
    // BiDi cannot activate an extension page, so the page activates its own tab.
    await sidebar.evaluate(async () => browser.tabs.update((await browser.tabs.getCurrent()).id, { active: true }));
    const target = await poll(sidebar, async () => {
      const tab = await window.foxmate.target();
      const shown = document.getElementById("target-name").textContent;
      return tab && shown === new URL(tab.url).hostname && { url: tab.url, shown, self: tab.url.startsWith(location.origin) };
    });
    check("UI2 the target is the web tab used last, never the foxmate page", { url: page.url(), shown: "127.0.0.1", self: false }, target);
    await saveShot(sidebar, "chat-empty");
    await page.close();
  } finally {
    await site.close();
  }

  // UI3: the toolbar's open-app brings the open app tab to the front; it opens no second one.
  const tabs = await sidebar.evaluate(async () => {
    const app = browser.runtime.getURL("app.html");
    const count = async () => (await browser.tabs.query({})).filter((t) => t.url?.startsWith(app)).length;
    const before = await count();
    await browser.runtime.sendMessage({ op: "open-app" });
    return { before, after: await count() };
  });
  check("UI3 open-app focuses the open app tab instead of a second one", { before: 1, after: 1 }, tabs);
}
