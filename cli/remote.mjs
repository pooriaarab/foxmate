// `foxmate bench` on Ichabod, Mozilla's cloud browser (FOXKIT_BROWSER=ichabod).
// The browser there cannot reach this computer's 127.0.0.1, so the bench
// mounts the task sites and the model servers on create-foxkit's one
// Cloudflare quick tunnel. Mount paths are numbered, so each model server
// sits behind a gate that forwards only under a random path: that path is
// the capability, and no log or score holds it. Only the remote bench build
// (dist-ext-bench/) takes a tunnel address as a local model.
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { createServer, request } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { browserMode, tunnel } from "create-foxkit/e2e";

const TUNNEL_HOST = /[a-z0-9-]+\.trycloudflare\.com/g;

export const isRemote = () => browserMode() === "ichabod";

/** The remote bench build (`pnpm build:ext --bench-remote`). */
export function benchExtension() {
  const dir = join(dirname(dirname(fileURLToPath(import.meta.url))), "dist-ext-bench");
  if (!existsSync(join(dir, "manifest.json"))) throw new Error("No dist-ext-bench/. Run: node scripts/build-ext.mjs --bench-remote");
  return dir;
}

/** Ichabod drops a session after about 12 minutes, so the bench starts a new one between tasks after this. */
export const SESSION_MS = 6 * 60_000;

/** The public URL of a task site on 127.0.0.1, and a close() for its mount. */
export async function publicSite(url) {
  const local = new URL(url);
  const mount = await tunnel(Number(local.port));
  return { url: `${mount.url}${local.pathname}${local.search}${local.hash}`, close: mount.close };
}

async function gate(target) {
  const secret = randomBytes(18).toString("hex");
  const server = createServer((req, res) => {
    if (!req.url?.startsWith(`/${secret}/`)) {
      req.resume();
      res.writeHead(404).end();
      return;
    }
    const upstream = request({ host: target.hostname, port: target.port, method: req.method, path: req.url.slice(secret.length + 1), headers: { ...req.headers, host: target.host } }, (answer) => {
      res.writeHead(answer.statusCode ?? 502, answer.headers);
      answer.pipe(res);
    });
    upstream.on("error", () => {
      if (!res.headersSent) res.writeHead(502);
      res.end();
    });
    req.pipe(upstream);
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const mount = await tunnel(server.address().port);
  return { url: `${mount.url}/${secret}${target.pathname.replace(/\/$/, "")}`, secret, close: async () => (await mount.close(), server.close()) };
}

/**
 * The planner settings with each model server on this computer moved to its
 * gate on the tunnel. redact(text) takes the gate paths and the tunnel host
 * out of a log.
 */
export async function reachModels(planner) {
  // The built library (pnpm build), loaded here so the adapter's tests need no build.
  const { HELPER_URL, PLANNERS } = await import("../dist/index.js");
  const gates = [];
  const via = async (address) => {
    const opened = await gate(new URL(address));
    gates.push(opened);
    return opened.url;
  };
  const info = PLANNERS.find((p) => p.id === (planner.planner || "saluki"));
  const settings = { ...planner };
  if (info?.baseURL) settings.baseURL = await via(planner.baseURL || info.baseURL);
  if (info?.baseURL && !planner.helper?.off) settings.helper = { ...planner.helper, baseURL: await via(planner.helper?.baseURL || HELPER_URL) };
  return {
    settings,
    redact: (text) => gates.reduce((t, g) => t.replaceAll(g.secret, "<gate>"), String(text)).replace(TUNNEL_HOST, "<tunnel>"),
    close: () => Promise.all(gates.map((g) => g.close())),
  };
}
