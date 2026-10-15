// On-policy labels for a planner fine-tune: the student's reply drives the run, and the same request goes to
// the teacher, whose reply is logged as the label. One JSON line per chat call, in scripts/trace-proxy.mjs's
// shape plus "onPolicy": true and the student's own reply; scripts/traces.mjs reads them (TR7, TR8).
//
//   node scripts/label-proxy.mjs <listen port> <student port> <teacher port> <log.jsonl>
//
// Point the bench's planner URL at http://127.0.0.1:<listen port>/v1.
import { appendFileSync } from "node:fs";
import { createServer } from "node:http";

const [listen, student, teacher, out] = process.argv.slice(2);
if (!listen || !student || !teacher || !out) {
  console.error("usage: node scripts/label-proxy.mjs <listen port> <student port> <teacher port> <log.jsonl>");
  process.exit(2);
}
/** The reply's text and tool calls, as trace-proxy.mjs writes them, or "" when the answer is not a chat reply. */
const replyOf = (text) => {
  try {
    const m = JSON.parse(text).choices?.[0]?.message;
    return m ? JSON.stringify({ content: m.content, calls: m.tool_calls?.map((c) => [c.function.name, c.function.arguments]) }) : "";
  } catch {
    return "";
  }
};
const server = createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = Buffer.concat(chunks);
  const send = (port) => fetch(`http://127.0.0.1:${port}${req.url}`, { method: req.method, headers: { "content-type": "application/json" }, body: req.method === "GET" || req.method === "HEAD" ? undefined : body });
  const chat = Boolean(req.url?.includes("chat"));
  // The teacher answers beside the student, so the run waits only for the student.
  const label = chat ? send(teacher).then(async (a) => ({ status: a.status, text: await a.text() })).catch(() => ({ status: 502, text: "" })) : undefined;
  let answer;
  try {
    answer = await send(student);
  } catch (error) {
    res.writeHead(502);
    res.end(String(error));
    return;
  }
  const buf = Buffer.from(await answer.arrayBuffer());
  res.writeHead(answer.status, { "content-type": answer.headers.get("content-type") ?? "application/json", "access-control-allow-origin": "*" });
  res.end(buf);
  if (!label) return;
  const t = await label;
  let request = {};
  try {
    request = JSON.parse(body.toString());
  } catch {
    // Not JSON: the line keeps an empty request, and traces.mjs skips it.
  }
  appendFileSync(out, `${JSON.stringify({ at: Date.now(), onPolicy: true, status: t.status, reply: t.status === 200 ? replyOf(t.text) : "", student: replyOf(buf.toString()), req: request })}\n`);
});
// Firefox keeps an idle connection for 115 s; Node's default 5 s close races a POST on a reused socket.
server.keepAliveTimeout = 600_000;
server.headersTimeout = 601_000;
server.listen(Number(listen), "127.0.0.1");
