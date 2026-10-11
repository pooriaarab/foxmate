// Finds a model server on this computer: llama-server and Ollama, both
// OpenAI-compatible. The onboarding and Settings use it. It reads only
// GET /models, and sends nothing else.
export const SERVERS = {
  llama: { name: "llama-server", baseURL: "http://127.0.0.1:8080/v1" },
  ollama: { name: "Ollama", baseURL: "http://127.0.0.1:11434/v1" },
};

/**
 * Asks a server for its models. Resolves with { state }:
 * "ok" (with models), "refused" (it answers 403: Ollama without
 * OLLAMA_ORIGINS), "error" (with status), or "off" (no answer).
 */
export async function probe(baseURL) {
  try {
    const answer = await fetch(`${baseURL.replace(/\/+$/, "")}/models`, { credentials: "omit", signal: AbortSignal.timeout(1500) });
    if (answer.status === 403) return { state: "refused" };
    if (!answer.ok) return { state: "error", status: answer.status };
    const body = await answer.json().catch(() => ({}));
    return { state: "ok", models: (body.data ?? []).map((m) => m.id).filter(Boolean) };
  } catch {
    return { state: "off" };
  }
}

/** The planner settings for a server that answered. */
export function plannerFor(server, models) {
  if (server === "llama") return models.some((m) => /saluki/i.test(m)) ? { planner: "saluki", model: "", baseURL: "" } : { planner: "llama-server", model: "", baseURL: "" };
  // An embedding model cannot plan; nor can a "-cloud" model run here.
  const local = models.find((m) => !m.endsWith("-cloud") && !/embed|minilm|bge|nomic/i.test(m));
  return { planner: "ollama", model: local ?? "", baseURL: "" };
}

/** One line for a probe result, in plain words. */
export function describe(server, result) {
  if (result.state === "ok") return `Connected ✓${result.models[0] ? ` · ${result.models[0]}` : ""}`;
  if (result.state === "refused") return server === "ollama" ? "Running, but it blocks foxmate. Start it with OLLAMA_ORIGINS." : "Running, but it blocks foxmate.";
  if (result.state === "error") return `Running, but it answered ${result.status}.`;
  return "Not running";
}
