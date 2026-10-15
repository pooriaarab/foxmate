// Forwards an OpenAI-style model server and writes one JSON line per chat call:
// the time, the status, llama-server's timings, the reply's text and tool calls,
// and the whole request. scripts/traces.mjs reads these lines.
//
//   node scripts/trace-proxy.mjs <listen port> <server port> <log.jsonl>
//
// Point the bench's planner URL at http://127.0.0.1:<listen port>/v1.
import { appendFileSync } from "node:fs";
import { createServer } from "node:http";

const [listen, target, out] = process.argv.slice(2);
if (!listen || !target || !out) {
  console.error("usage: node scripts/trace-proxy.mjs <listen port> <server port> <log.jsonl>");
  process.exit(2);
}
const server = createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = Buffer.concat(chunks);
  const at = Date.now();
  let answer;
  try {
    answer = await fetch(`http://127.0.0.1:${target}${req.url}`, { method: req.method, headers: { "content-type": "application/json" }, body: req.method === "GET" || req.method === "HEAD" ? undefined : body });
  } catch (error) {
    res.writeHead(502);
    res.end(String(error));
    return;
  }
  const buf = Buffer.from(await answer.arrayBuffer());
  res.writeHead(answer.status, { "content-type": answer.headers.get("content-type") ?? "application/json", "access-control-allow-origin": "*" });
  res.end(buf);
  if (!req.url?.includes("chat")) return;
  let reply = "";
  let timings = null;
  try {
    const j = JSON.parse(buf.toString());
    const m = j.choices?.[0]?.message;
    reply = JSON.stringify({ content: m?.content, calls: m?.tool_calls?.map((c) => [c.function.name, c.function.arguments]) });
    timings = j.timings ?? null;
  } catch {
    reply = buf.toString().slice(-600);
  }
  let request = {};
  try {
    request = JSON.parse(body.toString());
  } catch {
    // Not JSON: the line keeps an empty request, and traces.mjs skips it.
  }
  appendFileSync(out, `${JSON.stringify({ at, port: target, ms: Date.now() - at, status: answer.status, timings, reply, req: request })}\n`);
});
// Firefox keeps an idle connection for 115 s; Node's default 5 s close races a POST on a reused socket.
server.keepAliveTimeout = 600_000;
server.headersTimeout = 601_000;
server.listen(Number(listen), "127.0.0.1");
