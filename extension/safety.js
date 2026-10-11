// Settings > Approval rules and Saved logins. Rules are foxgate's standing
// answers for one site; the list has Remove (RU5). "Always ask" and "Never
// allow" name the site of the target tab; an allow rule comes only from an
// approval card (RU9). Saved logins go to the background page, which keeps
// the password in the login vault. This page keeps nothing, and the list
// shows no password (LV12).
import { logins, rules } from "./engine.js";
import { targetTab } from "./target.js";

const $ = (id) => document.getElementById(id);
const WORDS = { allow: "Always allow", ask: "Always ask", deny: "Never allow" };

function row(text, meta, onRemove, status) {
  const li = document.createElement("li");
  const p = document.createElement("p");
  p.className = "text";
  p.textContent = text;
  const m = document.createElement("div");
  m.className = "muted";
  m.textContent = meta;
  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "small";
  remove.textContent = "Remove";
  remove.addEventListener("click", () => onRemove().then(() => load("Removed."), (error) => { $(status).textContent = error.message; }));
  li.append(p, m, remove);
  return li;
}

function empty(text) {
  const li = document.createElement("li");
  li.className = "empty-row";
  li.textContent = text;
  return li;
}

async function loadRules(status = "") {
  const list = await rules.list();
  $("rules-list").replaceChildren(...(list.length ? list.map((r) => {
    const li = row(`${WORDS[r.effect]} ${r.tool ?? `every ${r.scope} step`} on ${r.site}`, r.id, () => rules.remove(r.id), "rules-status");
    li.dataset.ruleId = r.id;
    return li;
  }) : [empty("No rules yet. foxmate asks every time.")]));
  $("rules-status").textContent = status;
}

async function loadLogins(status = "") {
  const list = await logins.list();
  $("login-list").replaceChildren(...(list.length ? list.map((l) => {
    const li = row(l.host, `${l.username ? `${l.username} · ` : ""}password saved`, () => logins.remove(l.host), "login-status");
    li.dataset.host = l.host;
    return li;
  }) : [empty("No saved logins.")]));
  $("login-status").textContent = status;
}

/** Shows both lists. `status` goes to both status lines (a Remove sets it). */
async function load(status = "") {
  await Promise.all([loadRules(status), loadLogins(status)]);
}

async function addRule(effect) {
  try {
    // The full page is a tab of its own, so the rule names the tab foxmate works on.
    const tab = await targetTab();
    const { rule } = await rules.add(tab?.id, $("rule-scope").value, effect);
    await loadRules(`Added: ${WORDS[rule.effect]} on ${rule.site}.`);
  } catch (error) {
    $("rules-status").textContent = `No rule added: ${error.message}`;
  }
}

export const safety = {
  init() {
    $("login-form").addEventListener("submit", async (event) => {
      event.preventDefault();
      const password = $("login-pass").value;
      // The field clears before the answer, so the password does not stay on the page.
      $("login-pass").value = "";
      try {
        const { saved } = await logins.save({ site: $("login-site").value, username: $("login-user").value, password });
        $("login-site").value = "";
        $("login-user").value = "";
        await loadLogins(`Saved. The password for ${saved} is in foxvault.`);
      } catch (error) {
        $("login-status").textContent = `The login was not saved: ${error.message}`;
      }
    });
    $("rule-ask").addEventListener("click", () => addRule("ask"));
    $("rule-deny").addEventListener("click", () => addRule("deny"));
    load().catch(() => undefined);
  },
  // An approval answer can add a rule, and another foxmate page can remove one.
  message(message) {
    if (message.rulesChanged) loadRules().catch(() => undefined);
  },
  // Settings calls it each time it shows.
  load: () => load().catch(() => undefined),
};
