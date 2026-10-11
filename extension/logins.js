// Saved logins in Settings: the site, the username and the password go to
// the background page, which keeps the password in the login vault. The
// sidebar keeps nothing, and the list shows no password (LV12).
const $ = (id) => document.getElementById(id);
const send = async (message) => {
  const answer = await browser.runtime.sendMessage(message);
  if (answer?.error) throw new Error(answer.error);
  return answer;
};

async function load(status = "") {
  const { logins: saved } = await send({ op: "login-list" });
  $("login-list").replaceChildren(...saved.map((login) => {
    const li = document.createElement("li");
    li.dataset.host = login.host;
    const text = document.createElement("p");
    text.className = "text";
    text.textContent = `${login.host}${login.username ? ` · ${login.username}` : ""} · password saved`;
    const remove = document.createElement("button");
    remove.type = "button";
    remove.textContent = "Remove";
    remove.addEventListener("click", () => send({ op: "login-remove", host: login.host }).then(() => load("Removed."), (error) => { $("login-status").textContent = error.message; }));
    li.append(text, remove);
    return li;
  }));
  $("login-status").textContent = status || (saved.length ? "" : "No saved logins.");
}

export const logins = {
  init() {
    $("login-form").addEventListener("submit", async (event) => {
      event.preventDefault();
      const password = $("login-pass").value;
      // The field clears before the answer, so the password does not stay in the sidebar.
      $("login-pass").value = "";
      try {
        const { saved } = await send({ op: "login-save", site: $("login-site").value, username: $("login-user").value, password });
        $("login-site").value = "";
        $("login-user").value = "";
        await load(`Saved. The password for ${saved} is in foxvault.`);
      } catch (error) {
        $("login-status").textContent = `The login was not saved: ${error.message}`;
      }
    });
    load().catch(() => undefined);
  },
};
