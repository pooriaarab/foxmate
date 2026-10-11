// Tests for docs/failure-modes.md WF1, WF2 and WF5: how a kept step maps to
// the newest snapshot, and when a replay ends.
import type { Message } from "foxloop";
import type { Control, Snapshot } from "foxpaw";
import { describe, expect, it } from "vitest";
import { replayCall, toStep, workflowKey } from "../src/workflow.js";

const control = (id: string, role: string, label: string, more: Partial<Control> = {}): Control => ({
  id, frameId: 0, node: Number(id.split(":")[1]), role, tag: "button", type: "", label, name: "", placeholder: "", section: "", value: "",
  disabled: false, readOnly: false, required: false, offscreen: false, submit: false, dialog: false, autocomplete: false, picker: false, secret: false, guard: "g", ...more,
});
const page = (...controls: Control[]): Snapshot => ({ url: "http://shop.test/", title: "Shop", text: "", headings: [], frames: [], captcha: false, more: false, controls });
const ok: Message[] = [{ role: "assistant", content: null, tool_calls: [{ id: "a", type: "function", function: { name: "click", arguments: "{}" } }] }, { role: "tool", tool_call_id: "a", content: "click: ok\nDone." }];
const failed: Message[] = [ok[0]!, { role: "tool", tool_call_id: "a", content: "click: failed\nstale" }];

describe("workflow", () => {
  it("keys a workflow by host and goal, with spaces made one", () => {
    expect(workflowKey("shop.test", " Buy  one mug. ")).toBe(workflowKey("shop.test", "Buy one mug."));
    expect(workflowKey("shop.test", "Buy one mug.")).not.toBe(workflowKey("other.test", "Buy one mug."));
  });

  it("WF1: a click is kept as role, label and submit, and replays on the control that has them now", () => {
    const before = page(control("0:4", "button", "Add to cart", { submit: true }));
    const step = toStep("click", { controlId: "0:4" }, before)!;
    expect(step).toEqual({ name: "click", args: {}, control: { role: "button", label: "Add to cart", submit: true } });
    const now = page(control("0:2", "link", "Home"), control("0:9", "button", "Add to cart", { submit: true }));
    expect(replayCall(step, now, ok, false)).toEqual({ name: "click", arguments: JSON.stringify({ controlId: "0:9" }) });
  });

  it("WF1: no match, two matches, or a control with no snapshot ends the replay", () => {
    const step = toStep("act", { controlId: "0:4", op: "select", value: "L" }, page(control("0:4", "combobox", "Size")))!;
    expect(step.args).toEqual({ op: "select", value: "L" });
    expect(replayCall(step, page(control("0:4", "combobox", "Color")), ok, false)).toMatch(/no control/);
    expect(replayCall(step, page(control("0:4", "combobox", "Size"), control("0:5", "combobox", "Size")), ok, false)).toMatch(/2 controls/);
    expect(replayCall(step, undefined, ok, false)).toMatch(/snapshot/);
    expect(toStep("click", { controlId: "0:99" }, page())).toBeUndefined();
    expect(replayCall({ name: "open_url", args: { url: "http://shop.test/cart" } }, undefined, ok, false)).toEqual({ name: "open_url", arguments: JSON.stringify({ url: "http://shop.test/cart" }) });
  });

  it("WF2: a failed last step ends the replay", () => {
    expect(replayCall({ name: "snapshot", args: {} }, page(), failed, false)).toMatch(/failed/);
  });

  it("WF5: a page that foxshield flagged ends the replay", () => {
    expect(replayCall({ name: "snapshot", args: {} }, page(), ok, true)).toMatch(/foxshield/);
  });

  it("WF6: typing into a password field gives no step to keep", () => {
    expect(toStep("act", { controlId: "0:1", op: "type", value: "hunter2" }, page(control("0:1", "textbox", "Password", { secret: true })))).toBeNull();
  });
});
