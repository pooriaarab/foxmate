// Tests for docs/failure-modes.md DR1: the Firefox driver closes a session
// whose startup failed. create-foxkit's launch is a stub.
import { describe, expect, it, vi } from "vitest";

const fox = vi.hoisted(() => ({ closed: 0, fail: "" }));
vi.mock("create-foxkit/e2e", () => ({
  launch: async () => ({
    close: async () => { fox.closed += 1; },
    openExtensionPage: async () => {
      if (fox.fail === "open") throw new Error("no app page");
      return { evaluate: async () => undefined };
    },
  }),
  poll: async () => {
    if (fox.fail === "poll") throw new Error("foxmate did not load");
    return true;
  },
}));

describe("driver", () => {
  it("DR1: a failed startup closes the Firefox session and throws", async () => {
    // @ts-expect-error -- cli/ is plain JavaScript with no type declarations.
    const { startFox } = (await import("../cli/driver.mjs")) as { startFox: () => Promise<unknown> };
    for (const [fail, message] of [["open", "no app page"], ["poll", "foxmate did not load"]]) {
      fox.closed = 0;
      fox.fail = fail!;
      await expect(startFox()).rejects.toThrow(message);
      expect(fox.closed).toBe(1);
    }
    fox.fail = "";
    fox.closed = 0;
    await startFox();
    expect(fox.closed).toBe(0);
  });
});
