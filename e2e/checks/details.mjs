// D1 (G39-G43): a goal with a card number. Chat, each step's Details, the
// approval card, Today and the foxtrail log show the number masked, and the
// checkout field still gets the whole number.
import { saveShot } from "../lib.mjs";

const CARD = "4242 4242 4242 4242";
const RAW = /4242 ?4242 ?4242 ?4242|CVC 123/;
const type = (label, value) => ({ tool: "act", args: { controlId: `{{control:${label}}}`, op: "type", value } });

export default async function detailsCheck({ session, bench, check, scripted, finish, runGoal }) {
  const { sidebar } = session;
  bench.reset();
  bench.state.cart.push({ sku: "trail-mug", qty: 1, color: "Slate", size: null });
  const run = await runGoal(session, {
    url: `${bench.url}/shop/checkout`,
    goal: `Pay with my card ${CARD}, exp 12/29, CVC 123.`,
    // The human denies the Pay click: nothing is sent, and the card shows the exact action.
    answer: () => "deny",
    settings: scripted([
      { tool: "snapshot", args: {} },
      { tool: "act", args: { controlId: "{{control:Full name}}", op: "scroll", value: "300" } },
      type("Card number", CARD), type("CVC", "123"),
      { tool: "click", args: { controlId: "{{control:Pay}}" } },
      finish,
    ]),
  });
  const field = await run.page.evaluate(() => document.getElementById("card").value);
  const shown = await sidebar.evaluate(() => {
    const runs = document.querySelectorAll("#conversation > li.run");
    const last = runs[runs.length - 1];
    for (const box of last.querySelectorAll("details")) box.open = true;
    return { goal: last.querySelector(".goal").textContent, text: last.textContent, box: document.getElementById("goal").value };
  });
  await saveShot(sidebar, "details-mask");
  const { jsonl } = await sidebar.evaluate(() => browser.runtime.sendMessage({ op: "trail-export" }));
  const { tasks } = await sidebar.evaluate(() => browser.runtime.sendMessage({ op: "tasks" }));
  check("D1 the field gets the whole card number; Chat, Details, Today and the trail show it masked, and the goal box clears",
    { field: CARD, goal: "Pay with my card •••• 4242, exp 12/29, CVC •••.", box: "", chat: false, trail: false, today: false, trailOk: true },
    { field, goal: shown.goal, box: shown.box, chat: RAW.test(shown.text), trail: RAW.test(jsonl), today: RAW.test(JSON.stringify(tasks)), trailOk: run.trailOk });
}
