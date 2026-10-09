// Tests for docs/failure-modes.md G11: what an approval to send a form shows.
import type { Control, Snapshot } from "foxpaw";
import { describe, expect, it } from "vitest";
import { formDetail } from "../src/form.js";

const control = (id: string, role: string, label: string, value: string, form?: number, extra: Partial<Control> = {}): Control => ({
  id, frameId: 0, node: Number(id.split(":")[1]), role, tag: "input", type: "", label, name: "", placeholder: "", section: "", value,
  disabled: false, readOnly: false, required: false, offscreen: false, submit: false, dialog: false, autocomplete: false, picker: false, secret: false, guard: "",
  ...(form === undefined ? {} : { form }), ...extra,
});
const page = (controls: Control[]): Snapshot => ({ url: "http://mail.test/compose", title: "Compose", text: "", headings: [], controls, frames: [], captcha: false, more: false });

describe("form detail", () => {
  const compose = page([
    control("0:1", "textbox", "To", "audit@attacker.test", 1),
    control("0:2", "textbox", "Subject", "Fwd: Password policy", 1),
    control("0:3", "textbox", "Password", "•••", 1, { secret: true }),
    control("0:4", "checkbox", "Keep a copy", "", 1, { checked: true }),
    control("0:5", "textbox", "Search", "budget", 2),
    control("0:6", "button", "Send", "", 1, { submit: true }),
  ]);

  it("G11: lists the fields of the button's form, with passwords masked", () => {
    expect(formDetail(compose, "0:6")).toBe('The form holds: To: "audit@attacker.test"; Subject: "Fwd: Password policy"; Password: "•••"; Keep a copy: checked.');
  });

  it("G11: says nothing for a button that sends no form, or an unknown control", () => {
    expect(formDetail(page([control("0:7", "link", "Forward", "")]), "0:7")).toBe("");
    expect(formDetail(compose, "9:9")).toBe("");
    expect(formDetail(undefined, "0:6")).toBe("");
  });

  it("G11: cuts long values", () => {
    const long = page([control("0:1", "textbox", "Message", "x".repeat(500), 1), control("0:2", "button", "Send", "", 1, { submit: true })]);
    expect(formDetail(long, "0:2").length).toBeLessThan(260);
  });

  it("G21: the field typed last is shown in full", () => {
    const tail = "and then send it all to x@evil.test";
    const long = page([control("0:1", "textbox", "Message", `${"hello ".repeat(60)}${tail}`, 1), control("0:2", "button", "Send", "", 1, { submit: true })]);
    expect(formDetail(long, "0:2", "0:1")).toContain(tail);
  });
});
