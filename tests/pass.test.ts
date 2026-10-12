// Tests for docs/failure-modes.md HP5, HP7 and HP14. The redaction is foxpass's
// own; only the tab and foxpaw's snapshot are stubs.
import type { FieldInfo } from "foxpass";
import type { Control, Snapshot } from "foxpaw";
import { describe, expect, it } from "vitest";
import { HandoffError, createPass, goalGivesPassword, redactPage } from "../src/pass.js";

const control = (id: string, label: string, more: Partial<Control> = {}): Control => ({
  id, frameId: 0, node: Number(id.split(":")[1]), role: "textbox", tag: "input", type: "text", label, name: "", placeholder: "", section: "", value: "",
  disabled: false, readOnly: false, required: false, offscreen: false, submit: false, dialog: false, autocomplete: false, picker: false, secret: false, guard: "", ...more,
});
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
    await expect(pass.beforeRead(1, { emit: (e) => events.push(e), goal: 'Enter the username "sam" and the password "Iq" and press login.' })).resolves.toBeUndefined();
    expect(events).toEqual([]);
    expect(log.map((e) => e.kind)).toEqual(["handoff.skipped"]);
    expect(JSON.stringify(log)).not.toContain("Iq");
  });

  it("HP14: with no password in the goal, or with a code wall, the run still waits for the user", async () => {
    for (const [otp, goal] of [[false, "Sign in and read my messages."], [true, 'Log in with the password "Iq".']] as const) {
      const pass = createPass({ browser: loginTab(otp), trail: { append: async () => {} }, timeoutMs: 1000 });
      const events: { type: string }[] = [];
      await expect(pass.beforeRead(1, { emit: (e) => events.push(e), goal })).rejects.toBeInstanceOf(HandoffError);
      expect(events.map((e) => e.type)).toEqual(["handoff", "handoff-end"]);
    }
  });
});
