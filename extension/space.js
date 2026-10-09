// The Space view: the files in the foxden den. Dropped files go to /drop,
// and the planner's Python writes to /out.
const $ = (id) => document.getElementById(id);
const send = async (message) => {
  const answer = await browser.runtime.sendMessage(message);
  if (answer?.error) throw new Error(answer.error);
  return answer;
};

async function load(status = "Network: off") {
  $("space-status").textContent = "Opening the Space…";
  try {
    const { files } = await send({ op: "space-list" });
    $("space-list").replaceChildren(...files.map((file) => {
      const li = document.createElement("li");
      li.dataset.path = file.path;
      li.textContent = `${file.path} (${file.size} bytes) `;
      const remove = document.createElement("button");
      remove.type = "button";
      remove.textContent = "Delete";
      remove.addEventListener("click", () => send({ op: "space-delete", path: file.path }).then(() => load("Deleted.")));
      li.append(remove);
      return li;
    }));
    $("space-status").textContent = status;
  } catch (error) {
    $("space-status").textContent = `The Space did not open: ${error.message}`;
  }
}

export const space = {
  init() {
    $("space-files").addEventListener("change", async () => {
      for (const file of $("space-files").files) await send({ op: "space-write", name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) });
      $("space-files").value = "";
      await load("Added. Network: off");
    });
  },
  shown: () => load(),
};
