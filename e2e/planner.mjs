// A stand-in for llama-server on this computer. It answers each chat with
// the next tool call of a script, and keeps each request body, so a check
// can read exactly what the planner got. foxmind sees a local server.
import { createServer } from "node:http";

const noop = () => undefined;

export async function startPlanner() {
  const bodies = [];
  let script = [];
  let held = Promise.resolve();
  let release = noop;
  const json = { "content-type": "application/json", "access-control-allow-origin": "*", "access-control-allow-headers": "*" };
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    if (req.method === "OPTIONS") return res.writeHead(204, json).end();
    if (req.url.endsWith("/models")) return res.writeHead(200, json).end(JSON.stringify({ data: [{ id: "fake" }] }));
    const body = Buffer.concat(chunks).toString("utf8");
    bodies.push(body);
    await held;
    // A step can be a function of the request, for example to find a control id.
    const next = script.shift() ?? { tool: "finish", args: { summary: "The script ended." } };
    const step = typeof next === "function" ? next(body) : next;
    const call = { id: `call_${bodies.length}`, type: "function", function: { name: step.tool, arguments: JSON.stringify(step.args ?? {}) } };
    return res.writeHead(200, json).end(JSON.stringify({ choices: [{ index: 0, finish_reason: "tool_calls", message: { role: "assistant", content: "", tool_calls: [call] } }] }));
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  return {
    url: `http://127.0.0.1:${server.address().port}/v1`,
    bodies,
    /** The next run's tool calls. With hold, no answer goes out until release(). */
    play(steps, { hold = false } = {}) {
      script = [...steps];
      bodies.length = 0;
      held = hold ? new Promise((done) => (release = done)) : Promise.resolve();
    },
    release: () => release(),
    close: () => new Promise((done) => { server.closeAllConnections(); server.close(() => done()); }),
  };
}
