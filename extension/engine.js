// The messages to the background page for standing rules (foxgate) and
// saved logins (foxvault). The UI calls only the functions below.
//   rules:list              -> { rules: [{ id, site, scope, effect, tool? }] }
//   rules:add { tabId, scope, effect: "ask" | "deny" } -> { rule }
//   rules:remove { id }     -> { removed }
//   port: answer { requestId, answer: "always-allow" }
//                           foxgate adds an allow rule for the card's offer,
//                           then approves this request (RU1-RU10).
//   login-list              -> { logins: [{ host, username }] }  (never the password)
//   login-save { site, username, password } -> { saved: host }
//   login-remove { host }   -> { removed }
//   port: fill-login        at a sign-in wait: foxgate asks for the fill
//                           first, then foxpass fills the saved login (LV1-LV14).

const ask = async (message) => {
  const answer = await browser.runtime.sendMessage(message);
  if (answer?.error) throw new Error(answer.error);
  return answer;
};

export const rules = {
  list: async () => (await ask({ op: "rules:list" })).rules,
  /** Settings adds only "Always ask" or "Never allow", for the site of a tab (RU9). */
  add: (tabId, scope, effect) => ask({ op: "rules:add", tabId, scope, effect }),
  remove: (id) => ask({ op: "rules:remove", id }),
  /** Approves this request and keeps an allow rule for the card's offer. */
  approveAlways: (port, event) => port.postMessage({ op: "answer", requestId: event.requestId, answer: "always-allow" }),
};

export const logins = {
  list: async () => (await ask({ op: "login-list" })).logins,
  save: (login) => ask({ op: "login-save", ...login }),
  remove: (host) => ask({ op: "login-remove", host }),
  /** Asks to fill the saved login into the tab that the run waits on. */
  fill: (port) => port.postMessage({ op: "fill-login" }),
};
