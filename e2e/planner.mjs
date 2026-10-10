// A stand-in for llama-server on this computer. It answers each chat with
// the next tool call of a script, and keeps each request body, so a check
// can read exactly what the planner got. foxmind sees a local server.
import { createServer } from "node:http";

export async function startPlanner() {
  const bodies = [];
  let script = [];
  const json = { "content-type": "application/json", "access-control-allow-origin": "*", "access-control-allow-headers": "*" };
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    if (req.method === "OPTIONS") return res.writeHead(204, json).end();
    if (req.url.endsWith("/models")) return res.writeHead(200, json).end(JSON.stringify({ data: [{ id: "fake" }] }));
    bodies.push(Buffer.concat(chunks).toString("utf8"));
    const step = script.shift() ?? { tool: "finish", args: { summary: "The script ended." } };
    const call = { id: `call_${bodies.length}`, type: "function", function: { name: step.tool, arguments: JSON.stringify(step.args ?? {}) } };
    return res.writeHead(200, json).end(JSON.stringify({ choices: [{ index: 0, finish_reason: "tool_calls", message: { role: "assistant", content: "", tool_calls: [call] } }] }));
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  return {
    url: `http://127.0.0.1:${server.address().port}/v1`,
    bodies,
    /** The next run's tool calls. */
    play(steps) {
      script = [...steps];
      bodies.length = 0;
    },
    close: () => new Promise((done) => { server.closeAllConnections(); server.close(() => done()); }),
  };
}
