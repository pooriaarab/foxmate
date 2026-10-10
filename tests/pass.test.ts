// Tests for docs/failure-modes.md HP5 and HP7. The redaction is foxpass's
// own; only the tab and foxpaw's snapshot are stubs.
import type { FieldInfo } from "foxpass";
import type { Control, Snapshot } from "foxpaw";
import { describe, expect, it } from "vitest";
import { createPass, redactPage } from "../src/pass.js";

const control = (id: string, label: string, more: Partial<Control> = {}): Control => ({
  id, frameId: 0, node: Number(id.split(":")[1]), role: "textbox", tag: "input", type: "text", label, name: "", placeholder: "", section: "", value: "",
  disabled: false, readOnly: false, required: false, offscreen: false, submit: false, dialog: false, autocomplete: false, picker: false, secret: false, guard: "", ...more,
});
const field = (more: Partial<FieldInfo>): FieldInfo => ({
  selector: "#x", tag: "input", type: "text", autocomplete: "", name: "", id: "", label: "", placeholder: "", inputMode: "", maxLength: -1, visible: true, filled: true, form: 0, ...more,
});

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
});
