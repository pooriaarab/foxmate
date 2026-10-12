// The tier of a model server address, for foxmind. A release build passes
// none, so foxmind decides: only 127.0.0.1, localhost and [::1] are local,
// and foxmate refuses every other address (B1). Only the remote bench build
// (`node scripts/build-ext.mjs --bench-remote`, never shipped) swaps this
// module for scripts/bench-tier.mjs, so the extension on Ichabod can reach
// this computer's model through the bench tunnel.
export function modelTier(_baseURL: string): { tier?: "local" } {
  return {};
}
