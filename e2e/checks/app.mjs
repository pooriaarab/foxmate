// UI1-UI7: the app page. The first run shows the onboarding, and its demo
// approval sends nothing. Its extras pair a phone and save a login. The target is a web tab, never the foxmate page.
// "open-app" (the toolbar button) brings the open app tab to the front.
import { serve, poll } from "create-foxkit/e2e";
import { saveShot } from "../lib.mjs";

export default async function appCheck({ session, check }) {
  const { sidebar, fox } = session;

  // UI1: a fresh profile sees the onboarding; finishing it marks it done.
  await sidebar.evaluate(() => browser.storage.local.remove("onboarding"));
  await sidebar.evaluate(() => location.reload()).catch(() => undefined);
  await poll(sidebar, () => Boolean(window.foxmate) && document.getElementById("onboarding").open);
  await saveShot(sidebar, "onboarding-welcome");
  // These functions run in the page, so their helpers live inside them.
  const step = () => sidebar.evaluate(() => document.querySelector("#onboarding section[data-step]:not([hidden])").dataset.step);
  const next = (name, ghost = false) => sidebar.evaluate(async (n, g) => {
    document.querySelector(`#onboarding section[data-step="${n}"] ${g ? "button.ghost" : ""}[data-next]`).click();
    await new Promise((r) => setTimeout(r, 200));
  }, name, ghost);
  const seen = [await step()];
  await next("welcome");
  seen.push(await step());
  await next("model", true);
  seen.push(await step());
  await saveShot(sidebar, "onboarding-approvals");
  const demo = await sidebar.evaluate(async () => {
    const card = document.querySelector("#ob-demo li.ask");
    const buttons = [...card.querySelectorAll(".row button")].map((b) => b.textContent);
    const shown = { site: card.querySelector(".site").textContent, line: card.querySelector(".text").textContent, icon: card.querySelector(".site-icon").textContent, img: Boolean(card.querySelector("img")) };
    card.querySelector('button[data-answer="always-allow"]').click();
    await new Promise((r) => setTimeout(r, 150));
    return { buttons, ...shown, answered: document.querySelector("#ob-demo .answered")?.textContent ?? "", result: document.getElementById("ob-demo-result").textContent.startsWith("Always allowed.") };
  });
  await saveShot(sidebar, "onboarding-approvals-answered");
  await next("approvals");
  seen.push(await step());
  // UI6: "Pair a phone" moves the Settings pairing panel into the step and starts a pairing.
  const pair = await sidebar.evaluate(async () => {
    document.getElementById("ob-phone-pair").click();
    for (let i = 0; i < 100 && !document.getElementById("phone-offer").value; i++) await new Promise((r) => setTimeout(r, 100));
    return { inStep: Boolean(document.querySelector("#ob-phone-slot #phone-panel")), shown: !document.getElementById("phone-panel").hidden, offer: document.getElementById("phone-offer").value.length > 0, on: (await browser.storage.local.get("settings")).settings?.modules?.phone === true };
  });
  // UI7: the saved-login form saves through the Settings path, and the password field clears.
  const login = await sidebar.evaluate(async () => {
    document.getElementById("ob-login-open").click();
    document.getElementById("ob-login-site").value = "login.example.test";
    document.getElementById("ob-login-user").value = "sam@example.test";
    document.getElementById("ob-login-pass").value = "pw-onboarding-1";
    document.getElementById("ob-login-form").requestSubmit();
    for (let i = 0; i < 50 && !document.getElementById("ob-login-status").textContent; i++) await new Promise((r) => setTimeout(r, 100));
    const list = await browser.runtime.sendMessage({ op: "login-list" });
    return { status: document.getElementById("ob-login-status").textContent, cleared: document.getElementById("ob-login-pass").value === "", listed: list.logins.some((l) => l.host === "login.example.test" && !JSON.stringify(l).includes("pw-onboarding-1")) };
  });
  await saveShot(sidebar, "onboarding-extras");
  await next("extras");
  seen.push(await step());
  const back = await sidebar.evaluate(() => ({ home: Boolean(document.querySelector('section[data-view="settings"] #phone-panel')), button: !document.getElementById("ob-phone-pair").hidden }));
  const walk = await sidebar.evaluate(async () => {
    const dialog = document.getElementById("onboarding");
    const idea = document.querySelector("#ob-ideas button");
    const goal = idea.textContent;
    idea.click();
    for (let i = 0; i < 20 && dialog.open; i++) await new Promise((r) => setTimeout(r, 150));
    return {
      open: dialog.open, done: (await browser.storage.local.get("onboarding")).onboarding?.done === true,
      goal: document.getElementById("goal").value === goal, demoLeft: document.querySelectorAll("#ob-demo li").length,
      waiting: (await browser.runtime.sendMessage({ op: "tasks" })).waiting, rules: (await browser.runtime.sendMessage({ op: "rules:list" })).rules.length,
    };
  });
  check("UI1 the first run walks the onboarding to a first task, and the demo approval sends nothing",
    { seen: ["welcome", "model", "approvals", "extras", "first"], open: false, done: true, goal: true, demoLeft: 0, waiting: 0, rules: 0 }, { seen, ...walk });
  check("UI1 the demo card is the simple card, and Always allow works in the demo",
    { buttons: ["Deny", "Always allow", "Approve"], site: "bistro-lune.example", line: 'Send the form with "Book table"', icon: "B", img: false, answered: "Always allowed.", result: true }, demo);
  check("UI6 Pair a phone runs the Settings pairing inside the step, then puts it back", { inStep: true, shown: true, offer: true, on: true, home: true, button: true }, { ...pair, ...back });
  check("UI7 the onboarding saves a login through foxvault and clears the password", { status: "Saved for login.example.test.", cleared: true, listed: true }, login);
  await sidebar.evaluate(async () => {
    await browser.runtime.sendMessage({ op: "login-remove", host: "login.example.test" });
    const { settings = {} } = await browser.storage.local.get("settings");
    await browser.storage.local.set({ settings: { ...settings, modules: { ...settings.modules, phone: false } } });
  });
  await sidebar.evaluate(() => { document.getElementById("goal").value = ""; });

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
