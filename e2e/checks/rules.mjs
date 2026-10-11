// RU1, RU3, RU5, RU6, RU9 (rules): "Always allow" on an approval card adds a
// foxgate rule for the site. The next click on the site needs no approval,
// and the trail names the rule. After Remove in Settings the click asks
// again. After private data (a Space run) the rule does not skip the click.
// Firefox maps the host to 127.0.0.1, so it has a registrable site.
import { serve } from "create-foxkit/e2e";
import { saveShot } from "../lib.mjs";

export const RULE_HOSTS = "shop.foxrules.test";
const SITE = "foxrules.test";

const asked = (run) => new Set(run.approvals.map((a) => a.requestId)).size;
const rules = (sidebar) => sidebar.evaluate(() => browser.runtime.sendMessage({ op: "rules:list" }));

export default async function rulesCheck({ session, check, record, scripted, finish, runGoal }) {
  const { sidebar } = session;
  const site = await serve("e2e/site");
  const url = `${site.url.replace("127.0.0.1", RULE_HOSTS)}/table.html`;
  const book = scripted([{ tool: "snapshot", args: {} }, { tool: "click", args: { controlId: "{{control:Book a table}}" } }, finish]);
  // After "Always allow" the card keeps its disabled buttons until the request ends; wait for that.
  const answerWith = (choice, offers) => {
    const seen = new Set();
    return async (ask) => {
      if (seen.has(ask.requestId)) return "wait";
      seen.add(ask.requestId);
      offers.push(await sidebar.evaluate((id) => document.querySelector(`li.ask[data-request-id="${id}"] button[data-answer="always-allow"]`)?.textContent ?? null, ask.requestId));
      return choice;
    };
  };
  // The memory check leaves "When I book a table, my party size: 4". Notes make a run private (G17),
  // so these goals would never get an offer. Set the memories aside, and put them back at the end.
  const { memories } = await sidebar.evaluate(() => browser.runtime.sendMessage({ op: "memory-list" }));
  for (const m of memories) await sidebar.evaluate((id) => browser.runtime.sendMessage({ op: "memory-forget", id }), m.id);
  try {
    for (const { id } of (await rules(sidebar)).rules) await sidebar.evaluate((r) => browser.runtime.sendMessage({ op: "rules:remove", id: r }), id);
    const page = await session.fox.open(url);

    // RU1: the first click asks, and the card offers "Always allow click on <site>".
    const offers = [];
    const first = await runGoal(session, { page, goal: "Book a table.", settings: book, shot: "chat-always-allow", answer: answerWith("always-allow", offers) });
    const [rule] = (await rules(sidebar)).rules;
    check("RU1 the card offers Always allow for the click on the registrable site", { asks: 1, offer: `Always allow click on ${SITE}`, done: true }, { asks: asked(first), offer: offers[0], done: first.done });
    check("RU1 Always allow adds one allow rule for the site and the tool", { site: SITE, scope: "submit", tool: "click", effect: "allow" }, rule && { site: rule.site, scope: rule.scope, tool: rule.tool, effect: rule.effect });
    check("RU6 the trail records rule.add with the rule id", { ruleId: rule?.id, site: SITE, via: "sidebar" }, (({ ruleId, site: s, via } = {}) => ({ ruleId, site: s, via }))(first.trail.find((e) => e.kind === "rule.add")?.data));

    // The second click on the same site needs no approval, and the trail names the rule.
    await page.goto(url);
    const second = await runGoal(session, { page, goal: "Book a table again.", settings: book, shot: "chat-rule-allowed", answer: () => "deny" });
    const ruled = second.trail.find((e) => e.kind === "gate.rule")?.data;
    check("RU1 the next click on the site needs no approval", { asks: 0, done: true, booked: true }, { asks: asked(second), done: second.done, booked: second.url.includes("booked.html") });
    check("RU6 the trail shows the click allowed by the rule", { ruleId: rule?.id, decision: "allow", note: `allowed by rule ${rule?.id}` }, ruled && { ruleId: ruled.ruleId, decision: ruled.decision, note: ruled.note });
    check("RU6 Chat shows the rule line", true, second.steps.some((s) => s.startsWith("Rule") && s.includes(`allowed by rule ${rule?.id}`)));

    // RU5: Remove in Settings, then the click asks again.
    const listed = await sidebar.evaluate(async (id) => {
      window.foxmate.show("settings");
      for (let i = 0; i < 50 && !document.querySelector(`#rules-list li[data-rule-id="${id}"]`); i++) await new Promise((r) => setTimeout(r, 100));
      const text = document.querySelector(`#rules-list li[data-rule-id="${id}"] .text`)?.textContent ?? null;
      document.querySelector(`#rules-list li[data-rule-id="${id}"] button`)?.click();
      for (let i = 0; i < 50 && document.getElementById("rules-status").textContent !== "Removed."; i++) await new Promise((r) => setTimeout(r, 100));
      return { text, status: document.getElementById("rules-status").textContent };
    }, rule?.id);
    await saveShot(sidebar, "settings-rules");
    await sidebar.evaluate(() => window.foxmate.show("chat"));
    check("RU5 Settings lists the rule and removes it", { text: `Always allow click on ${SITE}`, status: "Removed.", left: 0 }, { ...listed, left: (await rules(sidebar)).rules.length });
    await page.goto(url);
    const third = await runGoal(session, { page, goal: "Book a table once more.", settings: book, answer: () => "approve" });
    check("RU5 after Remove the click asks again", { asks: 1, done: true, rule: false }, { asks: asked(third), done: third.done, rule: third.kinds.includes("gate.rule") });

    // RU1: add the rule again, then a run that reads private data (the Space) asks for the click, with no offer.
    await page.goto(url);
    await runGoal(session, { page, goal: "Book a table.", settings: book, answer: answerWith("always-allow", []) });
    const again = (await rules(sidebar)).rules;
    await page.goto(url);
    const privateOffers = [];
    const leak = await runGoal(session, {
      page, goal: "Sum a number, then book a table.", shot: "chat-rule-private",
      settings: scripted([{ tool: "run_python", args: { code: "1 + 1" } }, { tool: "snapshot", args: {} }, { tool: "click", args: { controlId: "{{control:Book a table}}" } }, finish]),
      answer: answerWith("deny", privateOffers),
    });
    check("RU1 on a private-data run the rule does not skip the click, and there is no offer", { rules: 1, private: true, asks: 1, offer: null, booked: false, rule: false },
      { rules: again.length, private: leak.kinds.includes("run.private"), asks: asked(leak), offer: privateOffers.length ? privateOffers[0] : "no ask", booked: leak.url.includes("booked.html"), rule: leak.kinds.includes("gate.rule") });

    // RU9: a message cannot add an allow rule; Never allow names the tab's registrable site.
    const tabId = await sidebar.evaluate((u) => window.foxmate.tabFor(u), page.url());
    const allow = await sidebar.evaluate((t) => browser.runtime.sendMessage({ op: "rules:add", tabId: t, scope: "submit", effect: "allow" }), tabId);
    const deny = await sidebar.evaluate((t) => browser.runtime.sendMessage({ op: "rules:add", tabId: t, scope: "submit", effect: "deny" }), tabId);
    check("RU9 rules:add refuses allow and adds Never allow for the site", { allow: "Settings adds only Always ask or Never allow rules.", deny: { site: SITE, effect: "deny" } },
      { allow: allow.error, deny: deny.rule && { site: deny.rule.site, effect: deny.rule.effect } });
    record.runs.rules = { first: first.kinds, second: second.kinds, third: third.kinds, private: leak.kinds };
    await page.close();
  } finally {
    // A failed step must not leave a run, a rule or the memories behind for the later checks.
    // A runtime port, not window.postMessage: it takes no target origin.
    // oxlint-disable-next-line unicorn/require-post-message-target-origin
    await sidebar.evaluate(() => window.foxmate.port.postMessage({ op: "stop" })).catch(() => undefined);
    for (const { id } of (await rules(sidebar)).rules) await sidebar.evaluate((r) => browser.runtime.sendMessage({ op: "rules:remove", id: r }), id);
    for (const m of memories) await sidebar.evaluate((t, k) => browser.runtime.sendMessage({ op: "memory-add", text: t, kind: k }), m.text, m.kind);
    await site.close();
  }
}
