// Tests for docs/failure-modes.md B1-B10. They stub fetch, so a test fails
// when the brain makes a network call that it must not make.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BrainError, KEY_HANDLE, createBrain } from "../src/brain.js";
import { withNotes } from "../src/recall.js";

let calls: { url: string; headers: Headers }[] = [];
const reply = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

beforeEach(() => {
  calls = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), headers: new Headers(init?.headers) });
    if (String(url).endsWith("/models")) return reply({ data: [{ id: "gpt-test" }] });
    return reply({ choices: [{ message: { role: "assistant", content: "hi" }, finish_reason: "stop" }] });
  }));
});
afterEach(() => vi.unstubAllGlobals());

const consent = (granted: boolean) => ({ hasDataConsent: async () => granted, goal: "a goal" });
const code = async (promise: Promise<unknown>) => promise.then(() => "resolved", (error: unknown) => (error instanceof BrainError ? error.code : String(error)));

describe("brain", () => {
  it("B1: private mode refuses a cloud planner without a network call", async () => {
    expect(await code(createBrain({ privacy: "private", planner: "openai", model: "gpt-test", consent: true }, consent(true)))).toBe("cloud-in-private");
    expect(await code(createBrain({ planner: "anthropic", consent: true }, consent(true)))).toBe("cloud-in-private");
    expect(calls).toEqual([]);
  });

  it("B2: private mode refuses an Ollama model that runs on Ollama's servers", async () => {
    for (const model of ["gpt-oss:120b-cloud", "qwen3-coder:480b-cloud", "deepseek-v3.1:671b:cloud"]) {
      expect(await code(createBrain({ planner: "ollama", model }, consent(true)))).toBe("cloud-model-in-private");
    }
    expect(calls).toEqual([]);
  });

  it("B3: private mode refuses a model server that is not on this computer", async () => {
    expect(await code(createBrain({ planner: "llama-server", baseURL: "http://192.168.1.5:8080/v1" }, consent(true)))).toBe("cloud-model-in-private");
    expect(await code(createBrain({ planner: "ollama", model: "qwen3:0.6b", baseURL: "https://ollama.example.com/v1" }, consent(true)))).toBe("cloud-model-in-private");
    expect(calls).toEqual([]);
  });

  it("B4: the own key needs the consent box", async () => {
    expect(await code(createBrain({ privacy: "own-key", planner: "openai", model: "gpt-test", consent: false }, consent(true)))).toBe("no-consent");
    expect(calls).toEqual([]);
  });

  it("B5: the own key needs Firefox's data consent too", async () => {
    expect(await code(createBrain({ privacy: "own-key", planner: "anthropic", consent: true }, consent(false)))).toBe("no-consent");
    expect(calls).toEqual([]);
  });

  it("B6: the provider sends only the foxvault handle, never a key", async () => {
    const brain = await createBrain({ privacy: "own-key", planner: "openai", model: "gpt-test", baseURL: "https://api.example.com/v1", consent: true }, consent(true));
    expect(brain.privacy).toBe("cloud");
    const result = await brain.mind.chat([{ role: "user", content: "hello" }], { tools: [] });
    expect(result.message.content).toBe("hi");
    const chat = calls.find((c) => c.url.endsWith("/chat/completions"));
    expect(chat?.url).toBe("https://api.example.com/v1/chat/completions");
    expect(chat?.headers.get("authorization")).toBe(`Bearer ${KEY_HANDLE}`);
  });

  it("B7: the default planner is Saluki 27B on llama-server, in private mode", async () => {
    const brain = await createBrain({}, consent(false));
    expect(brain.privacy).toBe("private");
    expect(brain.planner).toBe("saluki");
    expect(brain.mind.status?.().providers.map((p) => [p.name, p.tier])).toEqual([["saluki", "local"]]);
    expect(calls).toEqual([]);
  });

  it("B8: an unknown planner is refused", async () => {
    expect(await code(createBrain({ planner: "gpt-everything" }, consent(true)))).toBe("unknown-planner");
  });

  it("B9: a script that is not a JSON array is refused", async () => {
    expect(await code(createBrain({ planner: "scripted", script: "{\"tool\":\"snapshot\"}" }, consent(false)))).toBe("bad-script");
    expect(await code(createBrain({ planner: "scripted", script: "not json" }, consent(false)))).toBe("bad-script");
  });

  it("B10: {{lastUrl}} reads only the newest tool result", async () => {
    const script = JSON.stringify([{ tool: "open_url", args: { url: "{{lastUrl}}" } }]);
    const withLink = await createBrain({ planner: "scripted", script }, consent(false));
    const history = [
      { role: "user" as const, content: "a goal" },
      { role: "tool" as const, content: "old page: http://127.0.0.1:9/attacker.test/steal", tool_call_id: "1" },
      { role: "tool" as const, content: "new page with no link", tool_call_id: "2" },
    ];
    const first = await withLink.mind.chat(history, { tools: [] });
    expect(JSON.parse(first.message.tool_calls?.[0]?.function.arguments ?? "{}")).toEqual({ url: "" });
    const again = await createBrain({ planner: "scripted", script }, consent(false));
    const linked = await again.mind.chat([...history, { role: "tool", content: "see http://127.0.0.1:9/next", tool_call_id: "3" }], { tools: [] });
    expect(JSON.parse(linked.message.tool_calls?.[0]?.function.arguments ?? "{}")).toEqual({ url: "http://127.0.0.1:9/next" });
    expect(calls).toEqual([]);
  });

  it("B11: {{notes}} gives the notes under the goal", async () => {
    const script = JSON.stringify([{ tool: "browser_task", args: { goal: "name: Sam Lee, {{notes}}" } }]);
    const goal = withNotes("Book a table.", ["party size: 4", "seat: window"]);
    const brain = await createBrain({ planner: "scripted", script }, { ...consent(false), goal });
    const reply = await brain.mind.chat([{ role: "user", content: goal }], { tools: [] });
    expect(JSON.parse(reply.message.tool_calls?.[0]?.function.arguments ?? "{}")).toEqual({ goal: "name: Sam Lee, party size: 4, seat: window" });
    const none = await createBrain({ planner: "scripted", script }, { ...consent(false), goal: "Book a table." });
    const plain = await none.mind.chat([{ role: "user", content: "Book a table." }], { tools: [] });
    expect(JSON.parse(plain.message.tool_calls?.[0]?.function.arguments ?? "{}")).toEqual({ goal: "name: Sam Lee, " });
  });
});
