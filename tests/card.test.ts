// UI10, UI11, UI12: the approval for a form fill names where the form sends and
// which fields get a value, on the sidebar card and on the phone.
import { describe, expect, it } from "vitest";
// @ts-expect-error -- a plain JS module of the extension, with no types.
import { fieldsOf, phoneApproval, sendsTo } from "../extension/plain.js";

/** A browser_task approval as foxloop 0.1.8 asks it: args.form is foxpaw's preview (foxloop G16). */
const task = (form: Record<string, unknown> | undefined) => ({
  type: "approval-needed", requestId: "r1", expiresAt: Date.now() + 60_000,
  detail: "let foxpaw fill the form on https://shop.example/checkout/pay for the goal \"...\".",
  action: { tool: "browser_task", domain: "shop.example", scope: "submit", args: { goal: "email: sam@example.com, card number: 4242 4242 4242 4242", ...(form ? { form } : {}) } },
});
const FORM = {
  url: "https://shop.example/checkout/pay", sends: true, destination: "https://shop.example/checkout/pay?step=2", button: "Pay $40.00",
  fields: [{ label: "Email", value: "sam@example.com" }, { label: "Card number", value: "•••• 4242" }, { label: "CVC", value: "•••" }],
};

describe("UI10: the card names the destination and the fields", () => {
  it("says where the form sends as host and path, without the query", () => {
    expect(sendsTo(task(FORM).action)).toBe("Sends to shop.example/checkout/pay");
    expect(sendsTo(task({ ...FORM, destination: "https://pay.example:8443/" }).action)).toBe("Sends to pay.example:8443/");
  });

  it("says that nothing is sent when foxpaw found no destination", () => {
    expect(sendsTo(task({ ...FORM, destination: null }).action)).toBe("foxpaw found no destination, so nothing will be sent");
  });

  it("says nothing for a form fill that does not send, or another tool", () => {
    expect(sendsTo(task({ ...FORM, sends: false, destination: null }).action)).toBe("");
    expect(sendsTo(task(undefined).action)).toBe("");
    expect(sendsTo({ tool: "click", domain: "shop.example", args: { form: FORM } })).toBe("");
  });

  it("lists each field with the value foxpaw gives, sensitive ones masked", () => {
    expect(fieldsOf(task(FORM).action)).toEqual(["Email: sam@example.com", "Card number: •••• 4242", "CVC: •••"]);
    expect(fieldsOf(task(undefined).action)).toEqual([]);
  });

  it("cuts a long value and a long label", () => {
    const long = "x".repeat(200);
    const [line] = fieldsOf(task({ ...FORM, fields: [{ label: long, value: long }] }).action);
    expect(line.length).toBeLessThan(130);
    expect(line).toContain("…");
  });
});

describe("UI11: the phone names the destination too", () => {
  it("puts the destination in the title and the fields after the exact action", () => {
    const { title, detail } = phoneApproval(task(FORM));
    expect(title).toBe("foxmate asks: browser_task on shop.example, sends to shop.example/checkout/pay");
    const [exact, fields, says] = detail.split("\n\n");
    expect(JSON.parse(exact).tool).toBe("browser_task");
    expect(fields).toBe("Fields: Email: sam@example.com; Card number: •••• 4242; CVC: •••");
    expect(says).toMatch(/^foxmate says: let foxpaw fill the form/);
  });

  it("keeps the title and detail of other approvals", () => {
    const click = { ...task(undefined), action: { tool: "click", domain: "shop.example", args: { controlId: "0:1" } } };
    const { title, detail } = phoneApproval(click);
    expect(title).toBe("foxmate asks: click on shop.example");
    expect(detail.split("\n\n")).toHaveLength(2);
  });
});

describe("UI12: fill_and_send names its destination and fields", () => {
  const send = {
    tool: "fill_and_send", domain: "shop.example", scope: "submit",
    args: { fields: {}, send: "0:9", sendTarget: { id: "0:9", label: "Pay $40.00", action: "https://shop.example/checkout/pay?step=2" },
      targets: [{ id: "0:1", label: "Email", request: { op: "type", value: "sam@example.com" } }, { id: "0:2", label: "Terms", request: { op: "check" } }] },
  };
  it("says where the pinned button sends, and each field with its value", () => {
    expect(sendsTo(send)).toBe("Sends to shop.example/checkout/pay");
    expect(fieldsOf(send)).toEqual(["Email: sam@example.com", "Terms: checked"]);
    expect(sendsTo({ ...send, args: { ...send.args, sendTarget: { ...send.args.sendTarget, action: null } } })).toBe("foxpaw found no destination, so nothing will be sent");
  });
});
