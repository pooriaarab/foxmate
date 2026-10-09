// R1-R3: memory. A note that the user saved changes the plan: "book a
// table" uses the remembered party size. The Memory view reads, edits and
// deletes. The embedding model (MiniLM) runs in Firefox.
import { serve } from "create-foxkit/e2e";
import { saveShot } from "../lib.mjs";

export default async function memoryCheck({ session, check, record, scripted, finish, runGoal }) {
  const { sidebar } = session;
  const site = await serve("e2e/site");
  const book = (shot) => runGoal(session, {
    url: `${site.url}/table.html`, goal: "Book a table at Bistro Lune. name: Sam Lee", shot, timeoutMs: 240_000,
    settings: scripted([{ tool: "snapshot", args: {} }, { tool: "browser_task", args: { goal: "name: Sam Lee, {{notes}}" } }, finish]),
  });
  const ui = (fn, arg) => sidebar.evaluate(fn, arg);
  try {
    const before = await book();
    const add = async (text) => ui(async (t) => {
      window.foxmate.show("memory");
      document.getElementById("memory-text").value = t;
      document.getElementById("memory-form").requestSubmit();
      for (let i = 0; i < 1200 && !/^(Added|.*error|.*failed)/i.test(document.getElementById("memory-status").textContent); i++) await new Promise((r) => setTimeout(r, 100));
      return document.getElementById("memory-status").textContent;
    }, text);
    const started = Date.now();
    const added = [await add("When I book a table, my party size: 4"), await add("I take my coffee with oat milk.")];
    record.memoryAddMs = Date.now() - started;
    await saveShot(sidebar, "memory");
    await ui(() => window.foxmate.show("chat"));
    const after = await book("chat-memory");
    record.runs.memory = { before: before.approvals.map((a) => a.detail), after: after.approvals.map((a) => a.detail), steps: after.steps };
    check("R1 the Memory view adds memories with the in-browser model", ["Added.", "Added."], added);
    check("R2 without the memory, the table is for 2 (the page's default)", { done: true, party: "2" }, { done: before.done, party: new URL(before.url).searchParams.get("party") });
    check("R2 with the memory, the plan and the booking use party size 4", { note: true, approval: true, party: "4", coffee: false },
      { note: after.steps.some((s) => s.startsWith("Memory") && s.includes("party size: 4")), approval: after.approvals[0]?.detail.includes("party size: 4"), party: new URL(after.url).searchParams.get("party"), coffee: JSON.stringify(after.steps).includes("coffee") });

    // R3: edit, pin and delete through the view.
    const edited = await ui(async () => {
      window.foxmate.show("memory");
      // oxlint-disable-next-line unicorn/consistent-function-scoping -- this function runs in the page.
      const wait = async (fn) => { for (let i = 0; i < 50 && !fn(); i++) await new Promise((r) => setTimeout(r, 100)); };
      await wait(() => document.querySelectorAll("#memories li").length === 2);
      const coffee = [...document.querySelectorAll("#memories li")].find((li) => li.textContent.includes("coffee"));
      [...coffee.querySelectorAll("button")].find((b) => b.textContent === "Edit").click();
      coffee.querySelector("textarea").value = "I take my tea black.";
      [...coffee.querySelectorAll("button")].find((b) => b.textContent === "Save").click();
      await wait(() => document.getElementById("memory-status").textContent === "Saved.");
      const tea = [...document.querySelectorAll("#memories li")].find((li) => li.textContent.includes("tea"));
      [...tea.querySelectorAll("button")].find((b) => b.textContent === "Delete").click();
      await wait(() => document.getElementById("memory-status").textContent === "Deleted.");
      const texts = [...document.querySelectorAll("#memories .text")].map((p) => p.textContent);
      window.foxmate.show("chat");
      return texts;
    });
    check("R3 edit and delete change what foxmate remembers", ["When I book a table, my party size: 4"], edited);
  } finally {
    await site.close();
  }
}
