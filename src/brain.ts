// The brain: foxmate's settings in, a foxmind Mind out. foxmate uses only
// models on this computer or in Firefox: foxmind's `only: ["browser",
// "local"]` means a cloud provider is never probed or called
// (docs/failure-modes.md B1-B17). A fast helper model, when one runs, takes
// the done check (foxmind's `check` role); planning stays on the planner.
import { createMind, llamaServer, ollama, saluki, type Mind, type Provider } from "foxmind";
import type { Message, MindLike } from "foxloop";
import { PLANNERS, type PlannerId } from "./planners.js";
import { ScriptError, scriptMind } from "./scripted.js";

export { PLANNERS, type PlannerId };

export interface BrainSettings {
  planner?: string;
  model?: string;
  /** The address of a model server on this computer. */
  baseURL?: string;
  script?: string;
  /** False: no workflow cache, so no replay and nothing kept (WF8). Default: on. */
  replay?: boolean;
  /** False: the planner gets no ask_user tool (AQ4). Default: on. */
  ask?: boolean;
  /** The fast helper model for the done check. On by default at HELPER_URL; off when it does not answer (B15). */
  helper?: { off?: boolean; baseURL?: string };
}

/** The fast helper's default address: Qwen3.5-4B on a second llama-server. */
export const HELPER_URL = "http://127.0.0.1:8082/v1";
const HELPER_PROBE_MS = 1500;
// llama-server ignores a bare json_object for some models, and Qwen3.5-4B then fences its JSON.
// A schema makes it write the verdict only (B18).
const VERDICT = { type: "object", properties: { done: { type: "boolean" }, sure: { type: "boolean" }, why: { type: "string" } }, required: ["done", "sure", "why"] };
const HELPER_WAIT_MS = 20_000;

export interface BrainDeps {
  /** The goal, for the scripted planner. */
  goal?: string;
  /** The in-browser model provider. Loaded only when the user picks it. */
  browserModel?: () => Promise<Provider>;
}

export interface Brain {
  mind: MindLike & { status?: Mind["status"] };
  planner: PlannerId;
  /**
   * A check on the helper only, never the planner (B16, B17, B19), for the
   * finish check (G34) and the settle check (G47). Resolves undefined when the
   * run has no helper (B15). The wait is at most HELPER_WAIT_MS.
   */
  check?: (messages: Message[], signal?: AbortSignal, maxTokens?: number) => Promise<{ text: string; provider: string } | undefined>;
}

export type BrainErrorCode = "not-local" | "unknown-planner" | "bad-script" | "no-browser-model";

export class BrainError extends Error {
  constructor(readonly code: BrainErrorCode, message: string) {
    super(message);
    this.name = "BrainError";
  }
}

async function provider(id: PlannerId, settings: BrainSettings, deps: BrainDeps): Promise<Provider> {
  const model = settings.model?.trim() || undefined;
  const baseURL = settings.baseURL?.trim() || undefined;
  const at = baseURL ? { baseURL } : {};
  switch (id) {
    case "saluki": return saluki(at);
    case "llama-server": return llamaServer({ ...at, ...(model ? { model } : {}) });
    case "ollama": return ollama({ ...at, model: model ?? "qwen3:0.6b" });
    case "browser": {
      if (!deps.browserModel) throw new BrainError("no-browser-model", "The in-browser model runs only in the extension.");
      return deps.browserModel();
    }
    default: throw new BrainError("unknown-planner", `foxmate has no planner "${String(id)}".`);
  }
}

/** Makes the planner for the settings. Throws BrainError before any network call when the settings are not safe. */
export async function createBrain(settings: BrainSettings, deps: BrainDeps = {}): Promise<Brain> {
  const id = (settings.planner || "saluki") as PlannerId;
  const info = PLANNERS.find((p) => p.id === id);
  if (!info) throw new BrainError("unknown-planner", `foxmate has no planner "${id}". It uses only models on this computer.`);
  if (id === "scripted") {
    try {
      return { mind: scriptMind(settings.script || "[]", deps.goal ?? ""), planner: id };
    } catch (error) {
      throw new BrainError("bad-script", error instanceof ScriptError ? error.message : String(error));
    }
  }
  // foxmind decides the tier: a "-cloud" Ollama model or a server that is
  // not on this computer is "cloud", and `only` then leaves no provider.
  const planner = await provider(id, settings, deps);
  const helperURL = settings.helper?.baseURL?.trim() || HELPER_URL;
  const scout = id !== "browser" && !settings.helper?.off
    ? llamaServer({ name: "scout", baseURL: helperURL, body: { temperature: 0, chat_template_kwargs: { enable_thinking: false }, json_schema: VERDICT } })
    : undefined;
  if (scout && scout.tier !== "local") throw new BrainError("not-local", `The fast helper at ${helperURL} does not run on this computer. foxmate uses only models on this computer.`);
  let mind: Mind;
  try {
    mind = createMind({
      providers: [planner, ...(scout ? [scout] : [])],
      only: ["browser", "local"],
      ...(scout ? { roles: { plan: { use: [planner.name] }, check: { use: [scout.name] } } } : {}),
    });
  } catch (error) {
    if (!(error instanceof TypeError) || !/leaves no provider|cannot cross only/.test(error.message)) throw error;
    const model = settings.model ? `"${settings.model}"` : "This model";
    throw new BrainError("not-local", `${model} at ${settings.baseURL || info.baseURL} does not run on this computer. foxmate uses only models on this computer.`);
  }
  if (!scout) return { mind, planner: id };
  // One look at the helper per run, at the first check (B15).
  let up: Promise<boolean> | undefined;
  const check = async (messages: Message[], signal?: AbortSignal, maxTokens = 200) => {
    up ??= scout.probe({ timeoutMs: HELPER_PROBE_MS }).then((p) => p.ok, () => false);
    if (!(await up)) return undefined;
    const wait = AbortSignal.timeout(HELPER_WAIT_MS);
    const answer = await mind.chat(messages, { role: "check", maxTokens, signal: signal ? AbortSignal.any([signal, wait]) : wait });
    return { text: answer.message.content ?? "", provider: answer.provider };
  };
  return { mind, planner: id, check };
}
