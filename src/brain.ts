// The brain: foxmate's settings in, a foxmind Mind out. foxmate uses only
// models on this computer or in Firefox: foxmind's `only: ["browser",
// "local"]` means a cloud provider is never probed or called
// (docs/failure-modes.md B1-B12).
import { createMind, llamaServer, ollama, saluki, type Mind, type Provider } from "foxmind";
import type { MindLike } from "foxloop";
import { PLANNERS, type PlannerId } from "./planners.js";
import { ScriptError, scriptMind } from "./scripted.js";

export { PLANNERS, type PlannerId };

export interface BrainSettings {
  planner?: string;
  model?: string;
  /** The address of a model server on this computer. */
  baseURL?: string;
  script?: string;
}

export interface BrainDeps {
  /** The goal, for the scripted planner. */
  goal?: string;
  /** The in-browser model provider. Loaded only when the user picks it. */
  browserModel?: () => Promise<Provider>;
}

export interface Brain {
  mind: MindLike & { status?: Mind["status"] };
  planner: PlannerId;
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
  try {
    return { mind: createMind({ providers: [await provider(id, settings, deps)], only: ["browser", "local"] }), planner: id };
  } catch (error) {
    if (!(error instanceof TypeError) || !/leaves no provider/.test(error.message)) throw error;
    const model = settings.model ? `"${settings.model}"` : "This model";
    throw new BrainError("not-local", `${model} at ${settings.baseURL || info.baseURL} does not run on this computer. foxmate uses only models on this computer.`);
  }
}
