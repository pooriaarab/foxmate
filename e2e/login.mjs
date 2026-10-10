// A local bank with a sign-in wall: a password page, then a one-time code
// page, then the account. Only the person at the keyboard knows both.
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";

export const EMAIL = "sam@bank.example";
export const PASSWORD = "plum-Kettle-58";
export const CODE = "739204";

const page = (res, body) => res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(`<!doctype html><meta charset="utf-8">${body}`);
const go = (res, location, cookie) => res.writeHead(302, { location, ...(cookie ? { "set-cookie": `fmt_pass=${cookie}; Path=/; SameSite=Lax` } : {}) }).end();

export async function startLogin() {
  const stage = new Map();
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://x");
    const id = /(?:^|;\s*)fmt_pass=(\w+)/.exec(req.headers.cookie ?? "")?.[1];
    let body = "";
    for await (const chunk of req) body += chunk;
    const form = new URLSearchParams(body);
    if (url.pathname === "/logout") return go(res, "/login", "gone");
    if (url.pathname === "/login" && req.method === "POST") {
      if (form.get("password") !== PASSWORD) return go(res, "/login");
      const next = randomBytes(8).toString("hex");
      stage.set(next, "code");
      return go(res, "/verify", next);
    }
    if (url.pathname === "/verify" && req.method === "POST") {
      if (stage.get(id) !== "code" || form.get("code") !== CODE) return go(res, "/verify");
      stage.set(id, "in");
      return go(res, "/account");
    }
    if (url.pathname === "/verify" && stage.get(id) === "code") {
      return page(res, `<title>Verify</title><h1>Enter your code</h1><form method="post" action="/verify"><label for="code">Code from your phone</label> <input id="code" name="code" autocomplete="one-time-code" inputmode="numeric" maxlength="6"> <button type="submit">Verify</button></form>`);
    }
    if (url.pathname === "/account" && stage.get(id) === "in") return page(res, `<title>Account</title><h1>Your account</h1><p>Balance: $1,204.50</p><p><a href="/logout">Sign out</a></p>`);
    if (url.pathname !== "/login") return go(res, "/login");
    return page(res, `<title>Sign in</title><h1>Sign in to your bank</h1><form method="post" action="/login"><label for="email">Email</label> <input id="email" name="email" type="email" autocomplete="username"> <label for="password">Password</label> <input id="password" name="password" type="password" autocomplete="current-password"> <button type="submit">Sign in</button></form>`);
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((done) => { server.closeAllConnections(); server.close(() => done()); }) };
}
