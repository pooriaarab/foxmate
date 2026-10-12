// Tests for docs/failure-modes.md WF1, WF2, WF5 and WF12-WF21: how a kept step maps to
// the newest snapshot, and when a replay ends.
import type { Message } from "foxloop";
import type { Control, Snapshot } from "foxpaw";
import { describe, expect, it } from "vitest";
import { generalStep, goalShape, replayCall, shapeFits, shapeKey, toStep, workflowKey, type WorkflowStep } from "../src/workflow.js";

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

const step = (args: Record<string, unknown>, label = "From"): WorkflowStep => ({ name: "act", args, control: { role: "combobox", label, submit: false } });

describe("workflow shapes (WF12-WF17)", () => {
  const oneway = "Book a one-way flight from Toronto (YYZ) to Barcelona (BCN) on October 23, 2026 for 1 adult. Use the name Sam Park and the email sam.park@example.com.";
  const trap = "Book a one-way flight from Lisbon (LIS) to Madrid (MAD) on October 30, 2026 for 1 adult. Use the name Sam Park and the email sam.park@example.com.";
  const mugs = "Buy two Trail Mugs in the color Slate. Ship to Sam Park, 12 King St W, Toronto, M5H 1A1, email sam.park@example.com. Pay with the card 4242 4242 4242 4242, expiry 12/29, CVC 123.";
  const sand = "Buy one Trail Mug in the color Sand. Ship to Sam Park, 12 King St W, Toronto, M5H 1A1, email sam.park@example.com. Pay with the card 4242 4242 4242 4242, expiry 12/29, CVC 123.";

  it("WF12: goals that differ only in their values have one shape, and the values line up", () => {
    expect(goalShape(oneway).shape).toBe(goalShape(trap).shape);
    expect(goalShape(mugs).shape).toBe(goalShape(sand).shape);
    expect(goalShape(oneway).values).toEqual(["Toronto", "YYZ", "Barcelona", "BCN", "October 23, 2026", "1", "Sam Park", "sam.park@example.com"]);
    expect(goalShape(trap).values.slice(0, 5)).toEqual(["Lisbon", "LIS", "Madrid", "MAD", "October 30, 2026"]);
    expect(shapeKey("flights.test", oneway)).toBe(shapeKey("flights.test", trap));
    expect(shapeKey("flights.test", oneway)).not.toBe(workflowKey("flights.test", oneway));
  });

  it("WF13: kept values and labels are rewritten to the new goal's values, in the planner's forms", () => {
    expect(generalStep(step({ op: "select", value: "YYZ" }), oneway, trap)).toEqual(step({ op: "select", value: "LIS" }));
    expect(generalStep(step({ op: "date", value: "2026-10-23" }, "Depart"), oneway, trap)).toEqual(step({ op: "date", value: "2026-10-30" }, "Depart"));
    expect(generalStep(step({ op: "type", value: "10/23/2026" }, "Depart"), oneway, trap)).toEqual(step({ op: "type", value: "10/30/2026" }, "Depart"));
    const day = { name: "click", args: {}, control: { role: "button", label: "Friday, October 23, 2026", submit: false } };
    expect(generalStep(day, oneway, trap)).toEqual({ ...day, control: { ...day.control, label: "Friday, October 30, 2026", must: ["Friday, October 30, 2026"] } });
    expect(generalStep(step({ op: "select", value: "2" }, "Quantity"), mugs, sand)).toEqual(step({ op: "select", value: "1" }, "Quantity"));
    expect(generalStep({ name: "act", args: { op: "check" }, control: { role: "radio", label: "Slate", submit: false } }, mugs, sand)).toEqual({ name: "act", args: { op: "check" }, control: { role: "radio", label: "Sand", submit: false, must: ["Sand"] } });
    // Unchanged values stay as they are.
    expect(generalStep(step({ op: "type", value: "Sam Park" }, "Full name"), oneway, trap)).toEqual(step({ op: "type", value: "Sam Park" }, "Full name"));
    // A form of an old value that no rule rewrites ends the replay.
    expect(generalStep(step({ op: "type", value: "Oct 23" }, "Depart"), oneway, trap)).toMatch(/old goal/);
    expect(generalStep(step({ op: "type", value: "Toronto Pearson" }), oneway, trap)).toEqual(step({ op: "type", value: "Lisbon Pearson" }));
  });

  it("WF14: a choice with a number that no new value gives ends the replay", () => {
    const pick = { name: "click", args: {}, control: { role: "button", label: "Select Maple Air 12:43 for $414", submit: true } };
    expect(generalStep(pick, oneway, trap)).toMatch(/choice/);
    expect(generalStep({ name: "act", args: { op: "select", value: "0" }, control: { role: "combobox", label: "From", submit: false } }, oneway, trap)).toMatch(/choice/);
    const search = { name: "click", args: {}, control: { role: "button", label: "Search flights", submit: true } };
    expect(generalStep(search, oneway, trap)).toEqual(search);
    expect(generalStep({ name: "act", args: { op: "type", value: "4242 4242 4242 4242" }, control: { role: "textbox", label: "Card number", submit: false } }, mugs, sand)).not.toBeTypeOf("string");
  });

  it("WF16: a changed value that no kept step uses means no shape replay", () => {
    const one = "Buy one Trail Mug in the color Sand. Ship to Sam Park.";
    const two = "Buy two Trail Mugs in the color Slate. Ship to Sam Park.";
    const kept: WorkflowStep[] = [{ name: "click", args: {}, control: { role: "link", label: "Trail Mug", submit: false } },
      { name: "act", args: { op: "check" }, control: { role: "radio", label: "Sand", submit: false } }];
    expect(shapeFits(kept, one, two)).toMatch(/two/);
    expect(shapeFits([...kept, { name: "act", args: { op: "select", value: "1" }, control: { role: "combobox", label: "Quantity", submit: false } }], one, two)).toBeUndefined();
  });

  it("WF17: a rewritten label that no control has falls back to the one control that holds the new values", () => {
    const pick = generalStep({ name: "act", args: { op: "select" }, control: { role: "option", label: "Lisbon (LIS)", submit: false } }, trap, oneway) as WorkflowStep;
    expect(pick.control?.label).toBe("Toronto (YYZ)");
    const now = page(control("0:13", "option", "Toronto Pearson (YYZ)"), control("0:14", "option", "Lisbon (LIS)"));
    expect(replayCall(pick, now, ok, false)).toEqual({ name: "act", arguments: JSON.stringify({ controlId: "0:13", op: "select" }) });
    const mug = generalStep({ name: "click", args: {}, control: { role: "link", label: "Trail Mug", submit: false } }, sand, mugs) as WorkflowStep;
    expect(replayCall(mug, page(control("0:4", "link", "Trail Mug"), control("0:5", "link", "Trail Mugs Gift Set")), ok, false)).toMatch(/2 controls|no control/);
    expect(replayCall(mug, page(control("0:4", "link", "Trail Mug"), control("0:5", "link", "Delta Kite")), ok, false)).toEqual({ name: "click", arguments: JSON.stringify({ controlId: "0:4" }) });
    // Two controls hold the new value: no guess.
    expect(replayCall(pick, page(control("0:13", "option", "Toronto Pearson (YYZ)"), control("0:15", "option", "Toronto Island (YYZ)")), ok, false)).toMatch(/controls/);
  });

  it("WF15: other words, or a capital at the start of a sentence, make another shape", () => {
    expect(goalShape(oneway.replace("Book a one-way", "Book the latest one-way")).shape).not.toBe(goalShape(trap).shape);
    expect(goalShape("Do not subscribe. Create an account for Ana Silva.").shape).not.toBe(goalShape("Subscribe. Create an account for Ana Silva.").shape);
    expect(goalShape("Reply to Dana Lee's email about the Q4 budget.").values).toEqual(["Dana Lee", "Q4"]);
  });
});

describe("workflow shapes: one-pass rewrite (WF18-WF21)", () => {
  const there = "Book a flight from Paris to London.";
  const back = "Book a flight from London to Paris.";
  const recent = { name: "click", args: {}, control: { role: "link", label: "Recent: Paris to London", submit: false } };

  it("WF18: swapped values are rewritten in one pass, in typed values and labels", () => {
    expect(generalStep(step({ op: "type", value: "Paris to London" }, "Route"), there, back)).toEqual(step({ op: "type", value: "London to Paris" }, "Route"));
    const r = generalStep(recent, there, back) as WorkflowStep;
    expect(r.control?.label).toBe("Recent: London to Paris");
    expect(r.control?.must).toEqual(["London", "Paris"]);
    // The old-direction link is not the new route.
    expect(replayCall(r, page(control("0:3", "link", "Recent: Paris to London")), ok, false)).toMatch(/no control/);
  });

  it("WF19: a value that is part of another value is not rewritten inside it", () => {
    const a = "Book a flight from York to New York.", b = "Book a flight from Leeds to New Jersey.";
    expect(goalShape(a).values).toEqual(["York", "New York"]);
    expect(generalStep(step({ op: "type", value: "York to New York" }, "Route"), a, b)).toEqual(step({ op: "type", value: "Leeds to New Jersey" }, "Route"));
    // An unchanged long value keeps its short part.
    const c = "Book a flight from York to New York.", d = "Book a flight from Leeds to New York.";
    expect(generalStep(step({ op: "type", value: "York to New York" }, "Route"), c, d)).toEqual(step({ op: "type", value: "Leeds to New York" }, "Route"));
  });

  it("WF20: an old value with two new values ends the replay", () => {
    const a = "Book a flight from Paris to Paris.", b = "Book a flight from Rome to Oslo.";
    expect(generalStep(step({ op: "type", value: "Paris" }, "From"), a, b)).toMatch(/guess|two|more than one/);
    expect(generalStep({ name: "click", args: {}, control: { role: "link", label: "Fly to Paris now", submit: false } }, a, b)).toMatch(/guess|two|more than one/);
    // One new value for both places is not a guess.
    expect(generalStep(step({ op: "type", value: "Paris" }, "From"), a, "Book a flight from Rome to Rome.")).toEqual(step({ op: "type", value: "Rome" }, "From"));
  });

  it("WF21: the loose label match keeps the order of the new values", () => {
    const s: WorkflowStep = { name: "click", args: {}, control: { role: "link", label: "London to Paris", submit: false, must: ["London", "Paris"] } };
    expect(replayCall(s, page(control("0:3", "link", "Recent: Paris to London")), ok, false)).toMatch(/no control/);
    expect(replayCall(s, page(control("0:3", "link", "Recent: Paris to London"), control("0:4", "link", "Recent: London (LHR) to Paris (CDG)")), ok, false))
      .toEqual({ name: "click", arguments: JSON.stringify({ controlId: "0:4" }) });
    // A value named twice must be there twice.
    const twice: WorkflowStep = { name: "click", args: {}, control: { role: "link", label: "Rome to Rome", submit: false, must: ["Rome", "Rome"] } };
    expect(replayCall(twice, page(control("0:5", "link", "Rome round trip")), ok, false)).toMatch(/no control/);
  });
});
