// The brain: foxmate's settings in, a foxmind Mind out. Private mode uses
// foxmind's `only: ["browser", "local"]`, so a cloud provider is never
// probed or called. The own-key mode needs the consent box and Firefox's
// `websiteContent` data consent. The provider gets only a foxvault handle
// as its key; foxvault puts the real key in the header as the request
// leaves Firefox (docs/failure-modes.md B1-B10).
import { anthropic, createMind, llamaServer, ollama, openaiCompatible, saluki, type Mind, type Provider } from "foxmind";
import type { MindLike } from "foxloop";
import { ScriptError, scriptMind } from "./scripted.js";

export type Privacy = "private" | "own-key";
export type PlannerId = "saluki" | "llama-server" | "ollama" | "browser" | "scripted" | "openai" | "anthropic";

export interface BrainSettings {
  privacy?: Privacy;
  planner?: string;
  model?: string;
  /** A local server address, or the own-key API address. */
  baseURL?: string;
  /** The "send page text to this provider" box. */
  consent?: boolean;
  script?: string;
}

export interface BrainDeps {
  /** True when Firefox's `websiteContent` data consent is granted. */
  hasDataConsent: () => Promise<boolean>;
  /** The goal, for the scripted planner. */
  goal?: string;
  /** The in-browser model provider. Loaded only when the user picks it. */
  browserModel?: () => Promise<Provider>;
}

export interface Brain {
  mind: MindLike & { status?: Mind["status"] };
  /** `cloud` when page text goes to a provider outside this computer. */
  privacy: "private" | "cloud";
  planner: PlannerId;
}

export type BrainErrorCode = "cloud-in-private" | "cloud-model-in-private" | "no-consent" | "unknown-planner" | "bad-script" | "no-browser-model";

export class BrainError extends Error {
  constructor(readonly code: BrainErrorCode, message: string) {
    super(message);
    this.name = "BrainError";
  }
}

/** The handle that the provider gets in place of the key. */
export const KEY_HANDLE = "vault:model-key";

export const PLANNERS: readonly { id: PlannerId; label: string; cloud?: boolean; model?: string; baseURL?: string }[] = [
  { id: "saluki", label: "Underdog Saluki 27B (llama-server)", baseURL: "http://127.0.0.1:8080/v1" },
  { id: "ollama", label: "Ollama on this computer", model: "qwen3:0.6b", baseURL: "http://127.0.0.1:11434/v1" },
  { id: "llama-server", label: "llama-server on this computer", baseURL: "http://127.0.0.1:8080/v1" },
  { id: "browser", label: "In-browser small model (Qwen3-0.6B)" },
  { id: "scripted", label: "Scripted (no model)" },
  { id: "openai", label: "Your own key: OpenAI-compatible", cloud: true, model: "gpt-4.1-mini", baseURL: "https://api.openai.com/v1" },
  { id: "anthropic", label: "Your own key: Anthropic", cloud: true },
];

async function provider(id: PlannerId, settings: BrainSettings, deps: BrainDeps): Promise<Provider> {
  const model = settings.model?.trim() || undefined;
  const baseURL = settings.baseURL?.trim() || undefined;
  const at = baseURL ? { baseURL } : {};
  switch (id) {
    case "saluki": return saluki(at);
    case "llama-server": return llamaServer({ ...at, ...(model ? { model } : {}) });
    case "ollama": return ollama({ ...at, model: model ?? "qwen3:0.6b" });
    case "openai": return openaiCompatible({ baseURL: baseURL ?? "https://api.openai.com/v1", model: model ?? "gpt-4.1-mini", apiKey: KEY_HANDLE, tier: "cloud", name: "own-key" });
    case "anthropic": return anthropic({ apiKey: KEY_HANDLE, ...(model ? { model } : {}), ...(baseURL ? { baseURL } : {}) });
    case "browser": {
      if (!deps.browserModel) throw new BrainError("no-browser-model", "The in-browser model runs only in the extension.");
      return deps.browserModel();
    }
    default: throw new BrainError("unknown-planner", `foxmate has no planner "${String(id)}".`);
  }
}

/** Makes the planner for the settings. Throws BrainError before any network call when the settings are not safe. */
export async function createBrain(settings: BrainSettings, deps: BrainDeps): Promise<Brain> {
  const id = (settings.planner || "saluki") as PlannerId;
  const info = PLANNERS.find((p) => p.id === id);
  if (!info) throw new BrainError("unknown-planner", `foxmate has no planner "${id}".`);
  const privacy = settings.privacy ?? "private";
  if (id === "scripted") {
    try {
      return { mind: scriptMind(settings.script || "[]", deps.goal ?? ""), privacy: "private", planner: id };
    } catch (error) {
      throw new BrainError("bad-script", error instanceof ScriptError ? error.message : String(error));
    }
  }
  if (info.cloud) {
    if (privacy !== "own-key") throw new BrainError("cloud-in-private", `${info.label} is a cloud model. Private mode uses only models on this computer. Switch to "Own key" first.`);
    if (!settings.consent || !(await deps.hasDataConsent())) throw new BrainError("no-consent", "Allow sending page text to this provider in the settings first.");
    return { mind: createMind({ providers: [await provider(id, settings, deps)], only: ["cloud"] }), privacy: "cloud", planner: id };
  }
  // foxmind decides the tier: a "-cloud" Ollama model or a server that is
  // not on this computer is "cloud", and `only` then leaves no provider.
  try {
    return { mind: createMind({ providers: [await provider(id, settings, deps)], only: ["browser", "local"] }), privacy: "private", planner: id };
  } catch (error) {
    if (!(error instanceof TypeError) || !/leaves no provider/.test(error.message)) throw error;
    const model = settings.model ? `"${settings.model}"` : "This model";
    throw new BrainError("cloud-model-in-private", `${model} at ${settings.baseURL || info.baseURL} does not run on this computer. Private mode uses only models on this computer.`);
  }
}
