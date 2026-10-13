// A stand-in for create-foxkit's tunnel gateway (its T5), which a cloud browser
// such as Ichabod reaches a bench site through: the site is mounted at
// /_foxkit/1/, the prefix is cut before the request goes on, a path with no
// prefix goes to the mount that its Referer names, a redirect to /path gets the
// prefix back, and anything else is 404 (BN7).
import { createServer, request } from "node:http";
import type { AddressInfo } from "node:net";

const PREFIX = "/_foxkit/1";

/** The address of `site` (an http://127.0.0.1 URL) under the mount, and a close() for the gateway. */
export async function mountSite(site: string): Promise<{ url: string; close: () => Promise<void> }> {
  const local = new URL(site);
  const gateway = createServer((req, res) => {
    const url = req.url ?? "/";
    let path: string | undefined;
    if (url === PREFIX || url.startsWith(`${PREFIX}/`)) path = url.slice(PREFIX.length) || "/";
    else {
      let referer = "";
      try {
        referer = new URL(req.headers.referer ?? "").pathname;
      } catch {
        referer = "";
      }
      if (referer.startsWith(`${PREFIX}/`)) path = url;
    }
    if (path === undefined) {
      req.resume();
      res.writeHead(404, { "content-type": "text/plain" }).end("No server is mounted at this path.");
      return;
    }
    const upstream = request({ host: local.hostname, port: local.port, method: req.method, path, headers: { ...req.headers, host: local.host } }, (answer) => {
      const headers = { ...answer.headers };
      if (headers.location?.startsWith("/") && !headers.location.startsWith("//")) headers.location = `${PREFIX}${headers.location}`;
      res.writeHead(answer.statusCode ?? 502, headers);
      answer.pipe(res);
    });
    upstream.on("error", () => {
      if (!res.headersSent) res.writeHead(502);
      res.end();
    });
    req.pipe(upstream);
  });
  await new Promise<void>((done) => gateway.listen(0, "127.0.0.1", done));
  const { port } = gateway.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}${PREFIX}${local.pathname}${local.search}`,
    close: () => new Promise<void>((done) => gateway.close(() => done())),
  };
}
