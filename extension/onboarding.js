// The first run: what foxmate is, a model on this computer, how approvals
// work (a demo card that sends nothing), the optional extras (the
// microphone, phone pairing with the Settings panel, a saved login), and a
// first task. storage.local "onboarding" marks it done. Settings opens it again.
import { approvalCard, settle } from "./chat.js";
import { logins } from "./engine.js";
import { setFox } from "./fox.js";
import { SERVERS, describe, plannerFor, probe } from "./local-models.js";

const $ = (id) => document.getElementById(id);
const STEPS = ["welcome", "model", "approvals", "extras", "first"];
const POLL_MS = 2000;
// The demo card: the same card as a real run, with no port (UI1).
const DEMO = {
  requestId: "demo",
  action: { tool: "click", domain: "bistro-lune.example", scope: "submit", args: { target: { label: "Book table" } } },
  detail: 'The form holds: Name: "Sam Lee"; Party: "4"; Time: "19:30".',
  exactText: JSON.stringify({ args: { target: { label: "Book table" } }, domain: "bistro-lune.example", scope: "submit", tool: "click" }),
  ruleOffer: { site: "bistro-lune.example", scope: "submit", tool: "click" },
};
const DEMO_WORDS = {
  approve: "Approved. foxmate would send the form. This is a demo, so nothing was sent.",
  deny: "Denied. foxmate would not send it, and the goal stops.",
  "always-allow": "Always allowed. Next time, this click on bistro-lune.example needs no OK. You can remove the rule in Settings. Nothing was sent.",
};
let step = "welcome";
let poll;
let chosen;
let fill;

const dialog = () => $("onboarding");
const fox = () => dialog().querySelector(".fox");

async function readSettings() {
  return (await browser.storage.local.get("settings")).settings ?? {};
}

function go(next) {
  step = next;
  for (const section of dialog().querySelectorAll("section[data-step]")) section.hidden = section.dataset.step !== next;
  [...dialog().querySelectorAll(".ob-progress li")].forEach((li, i) => li.toggleAttribute("data-on", i <= STEPS.indexOf(next)));
  dialog().querySelector(`section[data-step="${next}"] h1`)?.focus();
  clearInterval(poll);
  setFox(fox(), "idle");
  if (next === "model") {
    setFox(fox(), "thinking");
    void look();
    poll = setInterval(look, POLL_MS);
  }
  if (next !== "extras") phoneBack();
  if (next === "approvals") demo();
  if (next === "first") ideas();
}

/** Looks for both servers, and picks the first that answers. */
async function look() {
  let best;
  for (const [id, server] of Object.entries(SERVERS)) {
    const result = await probe(server.baseURL);
    const row = dialog().querySelector(`[data-server="${id}"]`);
    row.dataset.state = result.state;
    row.querySelector(".server-status").textContent = describe(id, result);
    if (result.state === "ok" && !best) best = { id, ...plannerFor(id, result.models), label: result.models[0] ?? server.name };
  }
  if (step !== "model") return;
  $("ob-model-next").disabled = !best;
  if (!best) {
    $("ob-model-choice").textContent = "Start one of these. This page checks every 2 seconds.";
    return;
  }
  $("ob-model-choice").textContent = `foxmate uses ${best.label} on ${SERVERS[best.id].name}. You can change it in Settings.`;
  setFox(fox(), "done");
  if (chosen?.planner === best.planner && chosen?.model === best.model) return;
  chosen = best;
  const settings = await readSettings();
  await browser.storage.local.set({ settings: { ...settings, planner: best.planner, model: best.model, baseURL: best.baseURL } });
}

function demo() {
  setFox(fox(), "needs-approval");
  $("ob-demo-result").textContent = "";
  const card = approvalCard(DEMO, {
    onAnswer: (answer) => {
      setFox(fox(), answer === "deny" ? "idle" : "done");
      $("ob-demo-result").textContent = DEMO_WORDS[answer];
      // A real card waits for the rule after "Always allow"; the demo has none, so it ends here.
      if (answer === "always-allow") settle(card, "Always allowed.");
    },
  });
  $("ob-demo").replaceChildren(card);
}

function ideas() {
  setFox(fox(), "idle");
  $("ob-ideas").replaceChildren(...[...$("suggestions").querySelectorAll("button")].map((b) => {
    const li = document.createElement("li");
    const idea = document.createElement("button");
    idea.type = "button";
    idea.textContent = b.textContent;
    idea.addEventListener("click", () => finish(b.textContent));
    li.append(idea);
    return li;
  }));
}

// Phone pairing: the Settings panel (phone.js) moves into the step and back, so one
// pairing flow runs in both places (UI6). A comment marks its place in Settings.
let phoneHome;
async function pairPhone() {
  const panel = $("phone-panel");
  const settings = await readSettings();
  await browser.storage.local.set({ settings: { ...settings, modules: { ...settings.modules, phone: true } } });
  if (!phoneHome) {
    phoneHome = document.createComment("phone-panel");
    panel.before(phoneHome);
    $("ob-phone-slot").append(panel);
  }
  panel.hidden = false;
  $("ob-phone-pair").hidden = true;
  $("phone-pair").click();
}
function phoneBack() {
  if (!phoneHome) return;
  phoneHome.replaceWith($("phone-panel"));
  phoneHome = undefined;
  $("ob-phone-pair").hidden = false;
}

async function saveLogin(event) {
  event.preventDefault();
  const password = $("ob-login-pass").value;
  // The field clears before the answer, so the password does not stay in the page (UI7, LV12).
  $("ob-login-pass").value = "";
  try {
    const { saved } = await logins.save({ site: $("ob-login-site").value, username: $("ob-login-user").value, password });
    $("ob-login-site").value = "";
    $("ob-login-user").value = "";
    $("ob-login-status").textContent = `Saved for ${saved}.`;
  } catch (error) {
    $("ob-login-status").textContent = `Not saved: ${error.message}`;
  }
}

function closeUp() {
  clearInterval(poll);
  phoneBack();
  // The demo card leaves the page, so no test or view mistakes it for a real approval.
  $("ob-demo").replaceChildren();
  if (dialog().open) dialog().close();
}

async function finish(goal) {
  await browser.storage.local.set({ onboarding: { done: true } });
  closeUp();
  if (goal) fill(goal);
}

export const onboarding = {
  async init(_port, views) {
    fill = views.fill;
    for (const h1 of dialog().querySelectorAll("h1")) h1.tabIndex = -1;
    dialog().addEventListener("click", (event) => {
      if (event.target.closest("[data-next]")) go(STEPS[STEPS.indexOf(step) + 1]);
      else if (event.target.closest("[data-back]")) go(STEPS[STEPS.indexOf(step) - 1]);
      const copy = event.target.closest("[data-copy]");
      if (copy) {
        navigator.clipboard.writeText(copy.previousElementSibling.textContent).then(() => {
          copy.textContent = "Copied";
          setTimeout(() => { copy.textContent = "Copy"; }, 1500);
        }, () => { copy.textContent = "Select and copy"; });
      }
    });
    // Escape closes it for now; it comes back on the next open until it is done.
    dialog().addEventListener("close", closeUp);
    $("ob-finish").addEventListener("click", () => finish());
    $("ob-mic").addEventListener("click", () => browser.tabs.create({ url: browser.runtime.getURL("mic.html") }));
    $("ob-phone-pair").addEventListener("click", () => void pairPhone());
    $("ob-login-open").addEventListener("click", () => {
      const form = $("ob-login-form");
      form.hidden = !form.hidden;
      $("ob-login-open").setAttribute("aria-expanded", String(!form.hidden));
      if (!form.hidden) $("ob-login-site").focus();
    });
    $("ob-login-form").addEventListener("submit", saveLogin);
    browser.storage.onChanged.addListener((changes, area) => {
      if (area === "local" && changes.onboarding?.newValue?.done) closeUp();
    });
    const { onboarding: state } = await browser.storage.local.get("onboarding");
    // A notice opens the approval page: it shows the approval, not the setup.
    if (!state?.done && location.hash !== "#approval") onboarding.open();
  },
  open() {
    if (!dialog().open) dialog().showModal();
    go("welcome");
  },
};
