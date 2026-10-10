// A local copy of huggingface.co for the voice check, and foxvoice's test
// sound. Each file is downloaded once and kept in node_modules/.cache. The
// hub logs every request, so the check can see that no audio reached it.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";

const CACHE = "node_modules/.cache/foxmate-hub";
// John F. Kennedy's inaugural address, 1961 (public domain), as whisper.cpp ships it.
const JFK_URL = "https://github.com/ggml-org/whisper.cpp/raw/master/samples/jfk.wav";
export const JFK = "And so my fellow Americans, ask not what your country can do for you, ask what you can do for your country.";

async function cached(url) {
  mkdirSync(CACHE, { recursive: true });
  const file = join(CACHE, createHash("sha256").update(url).digest("hex"));
  if (!existsSync(file)) {
    const upstream = await fetch(url, { redirect: "follow" });
    if (!upstream.ok) throw Object.assign(new Error(`${url}: HTTP ${upstream.status}`), { status: upstream.status });
    writeFileSync(file, Buffer.from(await upstream.arrayBuffer()));
  }
  return readFileSync(file);
}

export const jfk = () => cached(JFK_URL);

export async function startHub() {
  const requests = [];
  const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-expose-headers": "*" };
  const server = createServer(async (req, res) => {
    requests.push(`${req.method} ${req.url}`);
    if (req.method === "OPTIONS") return res.writeHead(204, cors).end();
    try {
      const body = await cached(`https://huggingface.co${req.url}`);
      const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? "");
      if (!range) return res.writeHead(200, { ...cors, "content-type": "application/octet-stream", "content-length": String(body.length) }).end(body);
      const start = Number(range[1]);
      const end = Math.min(range[2] ? Number(range[2]) : body.length - 1, body.length - 1);
      return res.writeHead(206, { ...cors, "content-range": `bytes ${start}-${end}/${body.length}`, "content-length": String(end - start + 1) }).end(body.subarray(start, end + 1));
    } catch (error) {
      return res.writeHead(error.status ?? 502, cors).end(String(error));
    }
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  return { url: `http://127.0.0.1:${server.address().port}/`, requests, close: () => new Promise((done) => { server.closeAllConnections(); server.close(() => done()); }) };
}

const words = (text) => text.toLowerCase().replace(/[^a-z0-9' ]+/g, " ").split(/\s+/).filter(Boolean);

/** Word error rate: word edits over the words of the reference. */
export function wordErrorRate(reference, heard) {
  const ref = words(reference);
  const hyp = words(heard);
  let previous = Array.from({ length: hyp.length + 1 }, (_, j) => j);
  for (let i = 1; i <= ref.length; i++) {
    const row = [i];
    for (let j = 1; j <= hyp.length; j++) row[j] = Math.min(previous[j] + 1, row[j - 1] + 1, previous[j - 1] + (ref[i - 1] === hyp[j - 1] ? 0 : 1));
    previous = row;
  }
  return previous[hyp.length] / ref.length;
}
