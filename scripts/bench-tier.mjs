// The remote bench build's src/model-tier.ts (scripts/build-ext.mjs
// --bench-remote). On Ichabod the extension cannot reach 127.0.0.1, so the
// bench mounts this computer's model servers on its Cloudflare quick tunnel
// (cli/remote.mjs). foxmind would call that address "cloud"; here it is the
// local model. Release builds never contain this file.
export function modelTier(baseURL) {
  return /^https:\/\/[a-z0-9-]+\.trycloudflare\.com\/_foxkit\//.test(baseURL) ? { tier: "local" } : {};
}
