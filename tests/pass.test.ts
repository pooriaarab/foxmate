// Tests for docs/failure-modes.md HP5, HP7, HP14, HP17, HP18 and HP20. The redaction is foxpass's
// own; only the tab and foxpaw's snapshot are stubs.
import type { FieldInfo } from "foxpass";
import type { Control, Snapshot } from "foxpaw";
import { describe, expect, it } from "vitest";
import { HandoffError, createPass, goalGivesPassword, goalHosts, goalPasswords, maskPasswords, passwordElsewhere, passwordSite, redactPage } from "../src/pass.js";

const control = (id: string, label: string, more: Partial<Control> = {}): Control => ({
  id, frameId: 0, node: Number(id.split(":")[1]), role: "textbox", tag: "input", type: "text", label, name: "", placeholder: "", section: "", value: "",
  disabled: false, readOnly: false, required: false, offscreen: false, submit: false, dialog: false, autocomplete: false, picker: false, secret: false, guard: "", ...more,
});
/** HP20: a password site that takes every address, and one that takes only shop.test. */
const anySite = () => true;
const shopSite = (url: string) => new URL(url).hostname === "shop.test";
const wordpressSite = (url: string) => new URL(url).hostname === "wordpress.test";
/** HP20: an act call into a password field on shop.test, in a frame at `frameUrl`. */
const pinned = (frameUrl: string) => ({ value: "Blue-Kite-77!", target: { secret: true, url: "https://shop.test/login", frameUrl } });
const field = (more: Partial<FieldInfo>): FieldInfo => ({
  selector: "#x", tag: "input", type: "text", autocomplete: "", name: "", id: "", label: "", placeholder: "", inputMode: "", maxLength: -1, visible: true, filled: true, form: 0, ...more,
});

// A tab with a login form: a username field, a password field and, with `otp`, a code field.
const loginTab = (otp = false) => {
  const scan = {
    url: "http://127.0.0.1:5000/login", title: "Login", headings: [], frames: [], captchaMarks: [], webauthn: [],
    buttons: [{ text: "Login", type: "submit", visible: true, form: 0 }],
    fields: [field({ selector: "#user", name: "user", filled: false }), field({ selector: "#pw", type: "password", name: "pw", filled: false }),
      ...(otp ? [field({ selector: "#code", name: "code", autocomplete: "one-time-code", filled: false })] : [])],
  };
  return {
    tabs: { get: async () => ({ url: scan.url, status: "complete", windowId: 1 }), update: async () => ({}) },
    windows: { update: async () => ({}) },
    scripting: { executeScript: async ({ func }: { func: { name: string } }) => [{ result: func.name === "scanPage" ? scan : null }] },
  };
};

describe("pass", () => {
  it("HP5: a code that the user typed, and its copy in the page text, show [redacted]", () => {
    const page: Snapshot = {
      url: "http://bank.test/verify", title: "Verify", headings: [], frames: [], captcha: false, more: false,
      text: "We sent a code. You typed 739204.",
      controls: [control("0:1", "Verification", { name: "vc", value: "739204" }), control("0:2", "Search", { name: "q", value: "loans" })],
    };
    // foxpaw has no autocomplete text; the foxpass scan of the tab has it.
    const hints = [field({ name: "vc", label: "Verification", autocomplete: "one-time-code" })];
    const { page: safe, quotes } = redactPage(page, hints, ["Code 739204 is on its way"]);
    expect(JSON.stringify({ safe, quotes })).not.toContain("739204");
    expect(safe.controls[0]?.value).toBe("[redacted]");
    expect(safe.controls[1]?.value).toBe("loans");
    expect(safe.controls[0]?.autocomplete).toBe(false);
  });

  it("HP7: a scan that fails is logged, and the read goes on with no wait", async () => {
    const log: { kind: string }[] = [];
    const browser = {
      tabs: { get: async () => ({ url: "about:blank", status: "complete" }), update: async () => ({}) },
      windows: { update: async () => ({}) },
      scripting: { executeScript: async () => { throw new Error("Missing host permission for the tab"); } },
    };
    const pass = createPass({ browser, trail: { append: async (e) => { log.push(e); } } });
    const events: unknown[] = [];
    await expect(pass.beforeRead(1, { emit: (e) => events.push(e) })).resolves.toBeUndefined();
    expect(log.map((e) => e.kind)).toEqual(["handoff.scan-failed"]);
    expect(events).toEqual([]);
  });

  it("HP14: the goal names a password, in quotes or as a word with a digit or a symbol", () => {
    for (const goal of ['Enter the password "fE4" into both text fields and press submit.', "make sure to update the password to '1j1l-2k3j'.",
      'Enter the username "kanesha" and the password "Iq" into the text fields and press login.', "Type the PIN “4821” and send it.",
      "Log in as sam@example.com, password Tr4il-Mix-2026, then open my orders.", "Sign in with password: Blue-Kite-77!"]) expect(goalGivesPassword(goal), goal).toBe(true);
    for (const goal of ["Sign in to my bank and pay the bill.", "Reset my password.", 'Open the "password" settings page.', 'Open "password" and "security".', "Check my Gmail inbox.",
      "Reply to the email about the new password policy.", "Open my password manager.", "Change the password 2 times."])
      expect(goalGivesPassword(goal), goal).toBe(false);
  });

  it("HP14: a password wall is no wall when the goal gives the password; the log keeps the kinds only", async () => {
    const log: { kind: string; data: unknown }[] = [];
    const pass = createPass({ browser: loginTab(), trail: { append: async (e) => { log.push(e as never); } }, timeoutMs: 1000 });
    const events: unknown[] = [];
    await expect(pass.beforeRead(1, { emit: (e) => events.push(e), goal: 'Enter the username "sam" and the password "Iq" and press login.', host: "127.0.0.1" })).resolves.toBeUndefined();
    expect(events).toEqual([]);
    expect(log.map((e) => e.kind)).toEqual(["handoff.skipped"]);
    expect(JSON.stringify(log)).not.toContain("Iq");
  });

  it("HP14: with no password in the goal, or with a code wall, the run still waits for the user", async () => {
    for (const [otp, goal] of [[false, "Sign in and read my messages."], [true, 'Log in with the password "Iq".']] as const) {
      const pass = createPass({ browser: loginTab(otp), trail: { append: async () => {} }, timeoutMs: 1000 });
      const events: { type: string }[] = [];
      await expect(pass.beforeRead(1, { emit: (e) => events.push(e), goal, host: "127.0.0.1" })).rejects.toBeInstanceOf(HandoffError);
      expect(events.map((e) => e.type)).toEqual(["handoff", "handoff-end"]);
    }
  });

  it("HP17: redactPage marks each control whose value it replaced", () => {
    const page: Snapshot = {
      url: "http://bank.test/verify", title: "Verify", headings: [], frames: [], captcha: false, more: false, text: "",
      controls: [control("0:1", "Verification", { name: "vc", value: "739204" }), control("0:2", "Search", { name: "q", value: "loans" }), control("0:3", "Code", { name: "c", value: "" })],
    };
    const hints = [field({ name: "vc", label: "Verification", autocomplete: "one-time-code" }), field({ name: "c", label: "Code", autocomplete: "one-time-code" })];
    const { page: safe } = redactPage(page, hints);
    expect(safe.controls.map((c) => (c as { redacted?: boolean }).redacted ?? false)).toEqual([true, false, false]);
  });

  it("HP18: a password from the goal answers a wall only on the run's own site", async () => {
    const goal = 'Log in with the password "Iq".';
    const away = createPass({ browser: loginTab(), trail: { append: async () => {} }, timeoutMs: 1000 });
    await expect(away.beforeRead(1, { emit: () => {}, goal, host: "other.test" })).rejects.toBeInstanceOf(HandoffError);
    const sub = createPass({ browser: loginTab(), trail: { append: async () => {} }, timeoutMs: 1000 });
    await expect(sub.beforeRead(1, { emit: () => {}, goal })).rejects.toBeInstanceOf(HandoffError);
    const own = createPass({ browser: loginTab(), trail: { append: async () => {} }, timeoutMs: 1000 });
    await expect(own.beforeRead(1, { emit: () => {}, goal, host: "127.0.0.1" })).resolves.toBeUndefined();
  });

  it("HP16: a short password is masked where the goal stands inside a longer text, such as the goal with notes", () => {
    const goal = 'Enter the password "fE4" into both fields.';
    const shown = maskPasswords({ goal: `${goal}\n\nNotes: party of 4.`, other: "fE4 is a hex code" }, ["fE4"], goal);
    expect(shown.goal).toBe('Enter the password "•••" into both fields.\n\nNotes: party of 4.');
    expect(shown.other).toBe("fE4 is a hex code");
  });

  it("HP20: the goal's password never comes from an address, a 'to' or 'as' word, or a lower-case pin", () => {
    expect(goalPasswords("Email the password to admin@corp.com today.")).toEqual([]);
    expect(goalPasswords("Send the password as admin@corp.com.")).toEqual([]);
    expect(goalPasswords('Use the password "admin@corp.com".')).toEqual([]);
    expect(goalPasswords("Please pin 'News' to the top of the board.")).toEqual([]);
    expect(goalPasswords("Pin 'News' to the top.")).toEqual([]);
    expect(goalPasswords("Type the PIN '4821' and send it.")).toEqual(["4821"]);
    expect(goalPasswords("make sure to update the password to '1j1l-2k3j'.")).toEqual(["1j1l-2k3j"]);
    expect(goalPasswords("Log in as sam, password Tr4il-Mix-2026, then open my orders.")).toEqual(["Tr4il-Mix-2026"]);
  });

  it("HP20: a password goes only to the start tab's exact host, scheme and port, https unless on this computer", () => {
    const goal = "Log in as sam, password Tr4il-Mix-2026.";
    expect(passwordSite("https://shop.test/cart", "https://shop.test/login", goal)).toBe(true);
    expect(passwordSite("http://127.0.0.1:8790/", "http://127.0.0.1:8790/login", goal)).toBe(true);
    for (const [start, url] of [
      ["http://shop.test/cart", "http://shop.test/login"], ["https://shop.test/", "http://shop.test/login"], ["https://shop.test/", "https://shop.test:8443/login"],
      ["https://wordpress.test/", "https://attacker.wordpress.test/login"], ["https://shop.test/", "https://evil.test/login"], ["http://127.0.0.1:8790/", "http://127.0.0.1:8791/"],
      ["https://shop.test/", "not an address"],
    ] as [string, string][]) expect(passwordSite(start, url, goal), `${start} -> ${url}`).toBe(false);
    // A host the goal names must be the start host (an email address names no host).
    expect(passwordSite("https://shop.test/", "https://shop.test/login", "Log in to bank.test as sam, password Tr4il-Mix-2026.")).toBe(false);
    expect(passwordSite("https://www.shop.test/", "https://www.shop.test/login", "Log in to shop.test as sam, password Tr4il-Mix-2026.")).toBe(true);
    expect(passwordSite("https://shop.test/", "https://shop.test/login", "Sign up with email ana@example.com, password Tr4il-Mix-2026.")).toBe(true);
  });

  it("HP20: the password in an argument is found inside words, encoded, split in an address, or as a short value", () => {
    const pw = ["Blue-Kite-77!"];
    for (const args of [{ url: "https://shop.test/v?p=xBlue-Kite-77!" }, { url: "https://shop.test/v?p=Blue-Kite-77%21" }, { url: "https://shop.test/v?p=Blue-Kite-77%2521" },
      { url: "https://shop.test/v?a=Blue-&b=Kite-77!" }, { url: "https://shop.test/v?p=blue-kite-77!" }, { code: "print('xBlue-Kite-77!y')" }, { text: "Blue%2DKite%2D77%21" }])
      expect(passwordElsewhere("open_url", args, pw, anySite), JSON.stringify(args)).toBe(true);
    expect(passwordElsewhere("open_url", { text: "Blue+Kite+77%21" }, ["Blue Kite 77!"], anySite)).toBe(true);
    expect(passwordElsewhere("open_url", { url: "https://shop.test/kites?size=77&color=blue" }, pw, anySite)).toBe(false);
    // A short one: as a whole value, or as a whole query value of an address; never inside other words.
    expect(passwordElsewhere("open_url", { text: "Iq" }, ["Iq"], anySite)).toBe(true);
    expect(passwordElsewhere("open_url", { url: "https://x.test/?p=Iq" }, ["Iq"], anySite)).toBe(true);
    expect(passwordElsewhere("open_url", { url: "https://x.test/Iqaluit" }, ["Iq"], anySite)).toBe(false);
  });

  it("HP20: a password field in a frame from another site does not take the goal's password (C1)", () => {
    expect(passwordElsewhere("act", pinned("https://shop.test/login"), ["Blue-Kite-77!"], shopSite)).toBe(false);
    expect(passwordElsewhere("act", pinned("https://evil.test/frame"), ["Blue-Kite-77!"], shopSite)).toBe(true);
    expect(passwordElsewhere("act", pinned(""), ["Blue-Kite-77!"], shopSite)).toBe(true);
  });

  it("HP20: only the values the model gave are scanned, not the page's own target fields or the key names", () => {
    const login = { secret: true, url: "https://wordpress.test/wp-login.php", frameUrl: "https://wordpress.test/wp-login.php", guard: "[\"textbox\",\"wordpress-2026\"]", label: "Password", role: "textbox", node: 2 };
    // The right fill: the page address holds part of the password.
    expect(passwordElsewhere("fill", { fields: { "0:2": "wordpress-2026" }, targets: [{ ...login, id: "0:2", request: { op: "type", value: "wordpress-2026" } }] }, ["wordpress-2026"], wordpressSite)).toBe(false);
    // A click on a page whose address holds the PIN, and a call with a key named like the password.
    const acct = { secret: false, url: "https://bank.test/acct/481234", frameUrl: "https://bank.test/acct/481234", label: "Pay", role: "button", node: 7 };
    expect(passwordElsewhere("click", { controlId: "0:7", target: acct }, ["1234"], () => true)).toBe(false);
    expect(passwordElsewhere("act", { controlId: "0:1", op: "check", target: { ...acct, role: "checkbox" } }, ["secret"], () => true)).toBe(false);
    expect(passwordElsewhere("click", { controlId: "0:7", target: acct, secret: true } as Record<string, unknown>, ["secret"], () => true)).toBe(false);
    // An address on the password site whose host holds part of the password; its path and query are still checked.
    expect(passwordElsewhere("open_url", { url: "https://wordpress.test/wp-admin/" }, ["wordpress-2026"], wordpressSite)).toBe(false);
    expect(passwordElsewhere("open_url", { url: "https://wordpress.test/x?a=wordpr&b=ess-2026" }, ["wordpress-2026"], wordpressSite)).toBe(true);
    // A model value is still scanned.
    expect(passwordElsewhere("click", { controlId: "wordpress-2026", target: acct }, ["wordpress-2026"], wordpressSite)).toBe(true);
  });

  it("HP20: a target counts only on act, fill and fill_and_send; on another tool it is the model's own value", () => {
    const fake = { value: "Blue-Kite-77!", target: { secret: true, url: "https://shop.test/login", frameUrl: "https://shop.test/login" } };
    expect(passwordElsewhere("send_mail", fake, ["Blue-Kite-77!"], shopSite)).toBe(true);
    expect(passwordElsewhere("send_mail", { targets: [{ id: "0:2", secret: true, url: "https://shop.test/login", frameUrl: "https://shop.test/login", request: { value: "Blue-Kite-77!" } }] }, ["Blue-Kite-77!"], shopSite)).toBe(true);
    expect(passwordElsewhere("act", fake, ["Blue-Kite-77!"], shopSite)).toBe(false);
  });

  it("HP20: the trail masks a password inside other words only from 6 characters; a shorter one at word edges", () => {
    // A 4-5 character password that is a part of a host name stays: shop.test, test.shop.example (round 9 review).
    expect(maskPasswords({ a: "shop.test/contest", b: "testing", c: "https://test.shop.example/x" }, ["test"])).toEqual({ a: "shop.test/contest", b: "testing", c: "https://test.shop.example/x" });
    expect(maskPasswords({ a: "The password is test.", b: "typed test into 0:3", c: "?p=test&q=1", d: "(test)" }, ["test"])).toEqual({ a: "The password is •••.", b: "typed ••• into 0:3", c: "?p=•••&q=1", d: "(•••)" });
    expect(maskPasswords({ a: "xBlue-Kite-77!y" }, ["Blue-Kite-77!"])).toEqual({ a: "x•••y" });
  });

  it("HP20: a goal host with letters outside ASCII is read whole", () => {
    expect(goalHosts("Log in to bücher.de as sam, password Tr4il-Mix-2026.")).toEqual(["xn--bcher-kva.de"]);
    expect(passwordSite("https://xn--bcher-kva.de/", "https://xn--bcher-kva.de/login", "Log in to bücher.de as sam, password Tr4il-Mix-2026.")).toBe(true);
    expect(passwordSite("https://cher.de/", "https://cher.de/login", "Log in to bücher.de as sam, password Tr4il-Mix-2026.")).toBe(false);
  });

  it("HP20: a quoted password after \"to\" counts only when the goal changes, updates, sets or resets it", () => {
    expect(goalPasswords("Email the password to 'x9-secret' now.")).toEqual([]);
    expect(goalPasswords("Send the passcode to \"ops-team\".")).toEqual([]);
    expect(goalPasswords("make sure to update the password to '1j1l-2k3j'.")).toEqual(["1j1l-2k3j"]);
    expect(goalPasswords("Set my password to \"Ab12\" and reset the PIN to '9911'.")).toEqual(["Ab12", "9911"]);
    expect(goalPasswords('Change the password as "Zz9"')).toEqual([]);
  });
});
