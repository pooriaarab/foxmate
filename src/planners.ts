// The planner choices. Kept apart from brain.ts, so the sidebar can list
// them without bundling foxmind. `cloud` ones send page text to a provider.
export type PlannerId = "saluki" | "llama-server" | "ollama" | "browser" | "scripted" | "openai" | "anthropic";

export interface PlannerInfo {
  id: PlannerId;
  label: string;
  cloud?: boolean;
  model?: string;
  baseURL?: string;
  hint: string;
}

export const PLANNERS: readonly PlannerInfo[] = [
  { id: "saluki", label: "Underdog Saluki 27B (llama-server)", baseURL: "http://127.0.0.1:8080/v1", hint: "The default. Start llama-server with the Saluki GGUF: llama-server -m Underdog-Saluki-27B-1.0-IQ2-mix.gguf --jinja -ngl 99 -fa on -c 32768" },
  { id: "ollama", label: "Ollama on this computer", model: "qwen3:0.6b", baseURL: "http://127.0.0.1:11434/v1", hint: "Start Ollama with OLLAMA_ORIGINS=\"moz-extension://*\", or it refuses the extension. Models that end in -cloud run on Ollama's servers, so private mode refuses them." },
  { id: "llama-server", label: "llama-server on this computer", baseURL: "http://127.0.0.1:8080/v1", hint: "Start llama-server with --jinja, so it can call tools." },
  { id: "browser", label: "In-browser small model (Qwen3-0.6B)", hint: "Runs in Firefox. It downloads about 500 MB the first time, and it is slow and often wrong." },
  { id: "scripted", label: "Scripted (no model)", hint: "Replays the JSON tool calls below. For tests and demos." },
  { id: "openai", label: "Your own key: OpenAI-compatible", cloud: true, model: "gpt-4.1-mini", baseURL: "https://api.openai.com/v1", hint: "Any OpenAI-compatible API, for example OpenRouter. Page text goes to this provider." },
  { id: "anthropic", label: "Your own key: Anthropic", cloud: true, hint: "Page text goes to Anthropic." },
];

/** The host a cloud planner sends page text to. The consent box is for this host. */
export function providerHost(settings: { planner?: string; baseURL?: string }): string | undefined {
  const fallback = settings.planner === "anthropic" ? "https://api.anthropic.com" : "https://api.openai.com/v1";
  try {
    return new URL(settings.baseURL?.trim() || fallback).hostname;
  } catch {
    return undefined;
  }
}
