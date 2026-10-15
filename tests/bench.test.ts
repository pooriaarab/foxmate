// Tests for docs/failure-modes.md BN1-BN3, BN5 and BN6: the bench command's suite flag,
// the metrics that the adapter reports, and the Ask Sam answers. None needs Firefox.
import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { sites, startServer, taskById } from "foxbench";
import { describe, expect, it, vi } from "vitest";
// @ts-expect-error -- cli/ is plain JavaScript with no type declarations.
import { askSam, foxmateAdapter, runMetrics } from "../cli/bench.mjs";
import { mountSite } from "./mount.js";
// @ts-expect-error -- cli/ is plain JavaScript with no type declarations.
import { publicSite } from "../cli/remote.mjs";

// BN9: create-foxkit's tunnel, recorded: each mount's port and options, and which mounts are open.
const mounts = vi.hoisted(() => ({ made: [] as { port: number; root: boolean; open: boolean }[] }));
vi.mock("create-foxkit/e2e", async (original) => ({
  ...(await original<object>()),
  tunnel: async (port: number, options: { root?: boolean } = {}) => {
    const m = { port, root: Boolean(options.root), open: true };
    mounts.made.push(m);
    return { url: options.root ? "https://t.trycloudflare.com" : `https://t.trycloudflare.com/_foxkit/${mounts.made.length}`, close: async () => { m.open = false; } };
  },
}));
// foxbench's own user channel (tau2, Gaia2), which its index does not export.
import { scriptedUser, serveUser } from "../node_modules/foxbench/dist/bench/user.js";

/** A promise that waits until `fail` rejects it: one task's sidebar calls (BN5). */
function gate() {
  let reject: ((error: Error) => void) | undefined;
  const promise = new Promise<never>((_, no) => {
    reject = no;
  });
  promise.catch(() => {});
  return { promise, fail: () => reject?.(new Error("the run ended")) };
}

describe("bench", () => {
  it("BN1: an unknown suite exits with code 2 and lists the suites", () => {
    const run = spawnSync(process.execPath, ["cli/foxmate.mjs", "bench", "--suite", "nope"], { encoding: "utf8", timeout: 20_000 });
    expect(run.status).toBe(2);
    expect(run.stderr).toContain("core, hard, security+, all");
  });

  it("WF8: --replay takes only on or off, before Firefox starts", () => {
    const run = spawnSync(process.execPath, ["cli/foxmate.mjs", "bench", "--replay", "maybe"], { encoding: "utf8", timeout: 20_000 });
    expect(run.status).toBe(2);
    expect(run.stderr).toContain("--replay must be on or off.");
  });

  it("BN6: --fixed-ports takes a port, before Firefox starts", () => {
    const run = spawnSync(process.execPath, ["cli/foxmate.mjs", "bench", "--fixed-ports", "80"], { encoding: "utf8", timeout: 20_000 });
    expect(run.status).toBe(2);
    expect(run.stderr).toContain("--fixed-ports must be a port from 1024 to 65000.");
  });

  it("BN2: the metrics count planner calls, tool results and approvals from the trail", () => {
    const run = { approvals: [{}, {}], kinds: ["run.start", "loop.plan", "loop.tool-result", "loop.plan", "loop.tool-result", "loop.tool-result", "loop.done"] };
    expect((runMetrics as (r: unknown) => unknown)(run)).toEqual({ modelCalls: 2, replayed: 0, steps: 3, approvals: 2 });
  });

  it("WF8: a replayed step is not a model call", () => {
    const trail = [{ kind: "run.route", data: { by: "replay" } }, { kind: "run.route", data: { by: "replay" } }];
    const run = { approvals: [], kinds: ["loop.plan", "loop.plan", "loop.plan"], trail };
    expect((runMetrics as (r: unknown) => unknown)(run)).toEqual({ modelCalls: 1, replayed: 2, steps: 0, approvals: 0 });
  });

  it("BN3: a question goes to Ask Sam on the task's site and comes back with Sam's answer", async () => {
    const server = await startServer({ sites });
    const url = server.reset(taskById("shop-ambiguous-size"));
    const ask = askSam as (url: string, question: string) => Promise<string | undefined>;
    expect(await ask(url, "Which size of the Merino Hoodie do you want?")).toBe("Size L, please.");
    expect(server.state.questions.map((q) => q.text)).toEqual(["Which size of the Merino Hoodie do you want?"]);
    // Sam's newest answer, not the first one.
    expect(await ask(url, "Anything else? <b>&</b>")).toBe("Size L, please.");
    expect(server.state.questions.length).toBe(2);
    await server.close();
    expect(await ask(url, "Are you there?")).toBeUndefined();
  });

  it("BN8: a question to foxbench's user channel comes back with the user's newest answer, not the opening line", async () => {
    const user = scriptedUser({ opening: "Hi, I want to return my order.", answer: (q: string) => (q.includes("email") ? "It is sam.lee@example.com & thanks" : "Order #W123.") });
    const server = createServer((req, res) => void serveUser(user, req, res));
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
    const ask = askSam as (url: string, question: string) => Promise<string | undefined>;
    expect(await ask(url, "What is your email address?")).toBe("It is sam.lee@example.com & thanks");
    expect(await ask(url, "Which order?")).toBe("Order #W123.");
    expect(user.turns.filter((t) => t.from === "agent").map((t) => t.text)).toEqual(["What is your email address?", "Which order?"]);
    server.close();
  });

  it("BN9: each task site is mounted at the root of the tunnel, and a site an earlier task still holds is unmounted first", async () => {
    const first = await (publicSite as (url: string) => Promise<{ url: string; close: () => Promise<void> }>)("http://127.0.0.1:4101/towers-of-hanoi-hard?x=1");
    expect(first.url).toBe("https://t.trycloudflare.com/towers-of-hanoi-hard?x=1");
    const second = await (publicSite as (url: string) => Promise<{ url: string; close: () => Promise<void> }>)("http://127.0.0.1:4102/");
    expect(second.url).toBe("https://t.trycloudflare.com/");
    expect(mounts.made).toEqual([{ port: 4101, root: true, open: false }, { port: 4102, root: true, open: true }]);
    await first.close();
    expect(mounts.made[1]?.open).toBe(true);
    await second.close();
    expect(mounts.made[1]?.open).toBe(false);
  });

  it("BN7: a site behind a path mount (the tunnel a cloud browser uses) still gets the question, and Sam's answer comes back", async () => {
    const server = await startServer({ sites });
    const mount = await mountSite(server.reset(taskById("shop-cap-ask")));
    const ask = askSam as (url: string, question: string) => Promise<string | undefined>;
    expect(await ask(mount.url, "Total is $32.00, over your $30 limit. OK to proceed?")).toBe("Yes, $32 is fine. Go ahead and buy it.");
    expect(server.state.questions.map((q) => q.text)).toEqual(["Total is $32.00, over your $30 limit. OK to proceed?"]);
    await mount.close();
    await server.close();
  });

  it("BN5: a task that ends after its time limit closes its own tab, not the next task's", async () => {
    type Tab = { url: () => string; closed: boolean; close: () => Promise<void>; bringToFront: () => Promise<void> };
    const tabs: Tab[] = [];
    // Each task's sidebar calls wait until the test lets that task end.
    const gates: { promise: Promise<never>; fail: () => void }[] = [];
    const session = {
      fox: {
        open: async (url: string) => {
          gates.push(gate());
          const tab: Tab = { url: () => url, closed: false, close: async () => { tab.closed = true; }, bringToFront: async () => {} };
          tabs.push(tab);
          return tab;
        },
      },
      // The Stop message answers at once.
      sidebar: { evaluate: async (fn: () => unknown) => (String(fn).includes('"stop"') ? undefined : gates.at(-1)!.promise) },
    };
    const adapter = (foxmateAdapter as (s: unknown, o: unknown) => { runTask(i: { url: string; goal: string }): Promise<unknown>; abort(): Promise<void> })(session, { planner: { planner: "saluki" } });
    const late = adapter.runTask({ url: "http://127.0.0.1:1/a/", goal: "First task" }).catch(() => "late");
    await new Promise((r) => setTimeout(r, 10));
    await adapter.abort();
    const next = adapter.runTask({ url: "http://127.0.0.1:2/b/", goal: "Second task" }).catch(() => "next");
    await new Promise((r) => setTimeout(r, 10));
    gates[0]!.fail();
    expect(await late).toBe("late");
    expect(tabs[0]!.closed).toBe(true);
    expect(tabs[1]!.closed).toBe(false);
    gates[1]!.fail();
    await next;
    expect(tabs[1]!.closed).toBe(true);
  });
});
