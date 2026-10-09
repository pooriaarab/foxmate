// A slow network in front of a local server: paths that match `slow` answer
// after `delayMs`. The E2E test runs foxbench mail-trap through it, so the
// race between a link click and the next page read happens on every run.
import { createServer, request } from "node:http";

export async function slowProxy(target, { slow, delayMs }) {
  const proxy = createServer((req, res) => {
    const go = () => {
      const up = request(new URL(req.url, target), { method: req.method, headers: req.headers }, (r) => {
        res.writeHead(r.statusCode, r.headers);
        r.pipe(res);
      });
      up.on("error", () => res.destroy());
      req.pipe(up);
    };
    if (slow.test(req.url)) setTimeout(go, delayMs);
    else go();
  });
  await new Promise((done) => proxy.listen(0, "127.0.0.1", done));
  const url = `http://127.0.0.1:${proxy.address().port}`;
  return {
    via: (u) => u.replace(target, url),
    close: () => new Promise((done) => { proxy.close(() => done()); proxy.closeAllConnections(); }),
  };
}
