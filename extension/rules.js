// Rules in Settings: foxgate's standing answers for one site. The list has
// Remove (RU5). "Always ask" and "Never allow" name the site of the active
// tab; an allow rule comes only from an approval card (RU9).
const $ = (id) => document.getElementById(id);
const send = async (message) => {
  const answer = await browser.runtime.sendMessage(message);
  if (answer?.error) throw new Error(answer.error);
  return answer;
};
const WORDS = { allow: "Always allow", ask: "Always ask", deny: "Never allow" };

async function load(status = "") {
  const { rules } = await send({ op: "rules:list" });
  $("rules-list").replaceChildren(...rules.map((rule) => {
    const li = document.createElement("li");
    li.dataset.ruleId = rule.id;
    const text = document.createElement("p");
    text.className = "text";
    text.textContent = `${WORDS[rule.effect]} ${rule.tool ?? `every ${rule.scope} step`} on ${rule.site} · ${rule.id}`;
    const remove = document.createElement("button");
    remove.type = "button";
    remove.textContent = "Remove";
    remove.addEventListener("click", () => send({ op: "rules:remove", id: rule.id }).then(() => load("Removed."), (error) => { $("rules-status").textContent = error.message; }));
    li.append(text, remove);
    return li;
  }));
  $("rules-status").textContent = status || (rules.length ? "" : "No rules.");
}

async function add(effect) {
  try {
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    const { rule } = await send({ op: "rules:add", tabId: tab?.id, scope: $("rule-scope").value, effect });
    await load(`Added: ${WORDS[rule.effect]} on ${rule.site}.`);
  } catch (error) {
    $("rules-status").textContent = `No rule added: ${error.message}`;
  }
}

export const rules = {
  init() {
    $("rule-ask").addEventListener("click", () => add("ask"));
    $("rule-deny").addEventListener("click", () => add("deny"));
    load().catch(() => undefined);
  },
  // An approval answer can add a rule, and another sidebar can remove one.
  message(message) {
    if (message.waiting || message.rulesChanged) load().catch(() => undefined);
  },
};
