// The Memory view: read, add, edit, pin and delete what foxmate remembers.
// The memories live in foxmemory, in IndexedDB, in the background page.
const $ = (id) => document.getElementById(id);
const KINDS = { preference: "Preference", fact: "Fact", "task-note": "Task note" };
const send = async (message) => {
  const answer = await browser.runtime.sendMessage(message);
  if (answer?.error) throw new Error(answer.error);
  return answer;
};
const say = (text) => {
  $("memory-status").textContent = text;
};

function button(label, onClick) {
  const b = document.createElement("button");
  b.type = "button";
  b.textContent = label;
  b.addEventListener("click", () => onClick().catch((error) => say(error.message)));
  return b;
}

function row(item) {
  const li = document.createElement("li");
  li.dataset.id = item.id;
  const text = document.createElement("p");
  text.className = "text";
  text.textContent = item.text;
  const meta = document.createElement("div");
  meta.className = "muted";
  meta.textContent = `${KINDS[item.kind] ?? item.kind}${item.pinned ? " · pinned" : ""} · ${new Date(item.updatedAt).toLocaleDateString()}`;
  const actions = document.createElement("div");
  actions.className = "row";
  actions.append(
    button("Edit", async () => {
      const box = document.createElement("textarea");
      box.value = item.text;
      box.rows = 2;
      text.replaceWith(box);
      actions.replaceChildren(button("Save", async () => {
        await send({ op: "memory-update", id: item.id, patch: { text: box.value } });
        await load("Saved.");
      }), button("Cancel", () => load()));
    }),
    button(item.pinned ? "Unpin" : "Pin", async () => {
      await send({ op: "memory-update", id: item.id, patch: { pinned: !item.pinned } });
      await load();
    }),
    button("Delete", async () => {
      await send({ op: "memory-forget", id: item.id });
      await load("Deleted.");
    }),
  );
  li.append(text, meta, actions);
  return li;
}

async function load(status = "") {
  const { memories } = await send({ op: "memory-list" });
  $("memories").replaceChildren(...memories.map(row));
  say(status || (memories.length ? `${memories.length} memories.` : "No memories yet."));
}

export const memory = {
  init() {
    $("memory-form").addEventListener("submit", async (event) => {
      event.preventDefault();
      say("Adding… The first one loads the model in Firefox.");
      try {
        await send({ op: "memory-add", text: $("memory-text").value, kind: $("memory-kind").value });
        $("memory-text").value = "";
        await load("Added.");
      } catch (error) {
        say(error.message);
      }
    });
  },
  shown: () => load(),
};
