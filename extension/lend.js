// The Lend view: lend the current site to foxmate with foxlend, run a goal
// in the lent tab, and revoke. It also lists the requests that the guard
// blocked.
const $ = (id) => document.getElementById(id);
const SCOPES = { read: "read", fill: "read and fill", submit: "read, fill and send" };
let show;

const send = async (message) => {
  const answer = await browser.runtime.sendMessage(message);
  if (answer?.error) throw new Error(answer.error);
  return answer;
};

function loanRow(loan) {
  const li = document.createElement("li");
  li.dataset.loanId = loan.id;
  const text = document.createElement("p");
  text.className = "text";
  text.textContent = `${loan.domain}: ${SCOPES[loan.scope]}, until ${new Date(loan.expiresAt).toLocaleTimeString()}${loan.state === "active" ? "" : ` (${loan.state})`}`;
  const meta = document.createElement("div");
  meta.className = "muted";
  meta.textContent = `${loan.containerName} · ${loan.copied} cookies copied · may reach ${loan.patterns.join(", ")}`;
  const goal = document.createElement("textarea");
  goal.rows = 2;
  goal.placeholder = "A goal for the lent tab";
  const actions = document.createElement("div");
  actions.className = "row";
  const run = document.createElement("button");
  run.type = "button";
  run.textContent = "Run here";
  run.dataset.action = "run";
  run.addEventListener("click", () => {
    show("chat");
    window.foxmate.start(loan.tabId, goal.value, loan.id);
  });
  const revoke = document.createElement("button");
  revoke.type = "button";
  revoke.textContent = "Revoke";
  revoke.dataset.action = "revoke";
  revoke.addEventListener("click", async () => {
    $("lend-status").textContent = "Revoking…";
    await send({ op: "revoke", loanId: loan.id }).then(() => load("Revoked. The container and its cookies are gone."), (error) => load(error.message));
  });
  actions.append(run, revoke);
  li.append(text, meta, goal, actions);
  return li;
}

function blockedRow(b) {
  const li = document.createElement("li");
  li.className = "bad";
  li.textContent = `${new Date(b.at).toLocaleTimeString()} blocked ${b.type} to ${b.url} (${b.layer})`;
  return li;
}

async function load(status) {
  const { loans, blocked } = await send({ op: "loans" });
  $("loans").replaceChildren(...loans.map(loanRow));
  $("blocked").replaceChildren(...blocked.toReversed().map(blockedRow));
  if (status !== undefined) $("lend-status").textContent = status;
  if (!$("lend-url").value) {
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    if (tab?.url?.startsWith("http")) $("lend-url").value = tab.url;
  }
}

export const lend = {
  init(_port, views) {
    show = views.show;
    $("lend-form").addEventListener("submit", async (event) => {
      event.preventDefault();
      $("lend-status").textContent = "Lending…";
      try {
        const url = new URL($("lend-url").value);
        const allow = $("lend-allow").value.split(",").map((h) => h.trim()).filter(Boolean);
        const { loan } = await send({ op: "lend", domain: url.hostname, url: url.href, scope: $("lend-scope").value, ttlMs: Number($("lend-ttl").value), allow });
        await load(`Lent ${loan.domain}. Its tab is open in ${loan.containerName}.`);
      } catch (error) {
        $("lend-status").textContent = `Not lent: ${error.message}`;
      }
    });
  },
  shown: () => load(),
  message(message) {
    if (message.loansChanged || message.blocked) {
      if (!$("loans").closest("section").hidden) load();
    }
  },
};
