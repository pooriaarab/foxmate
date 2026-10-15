"""Replays real planner requests (teacher traces) to a small llama-server
planner and checks each tool call the way foxloop does, plus the element id
check of foxloop's browser tools. Two arms: the request as foxmate sends it,
and the same request with the ids of the current page as a JSON Schema enum,
which llama-server turns into a grammar.

    python3 replay.py <planner.jsonl> <base url> <out.jsonl> [--every 3]
"""
import json, re, sys, time, urllib.request

src, base, out = sys.argv[1:4]
every = int(sys.argv[sys.argv.index("--every") + 1]) if "--every" in sys.argv else 3
ID = re.compile(r"\[(\d+:\d+)\]|=(\d+:\d+)\b")
ID_ARGS = {"click": ["controlId"], "act": ["controlId"], "fill_and_send": ["send"]}
FIELD_TOOLS = {"fill", "fill_and_send"}


def page_ids(messages):
    """The ids of the last page the planner saw: the newest full page, plus every diff after it."""
    ids = set()
    for m in reversed(messages):
        if m["role"] != "tool" or "<<<DATA" not in (m.get("content") or ""):
            continue
        text = m["content"]
        ids |= {a or b for a, b in ID.findall(text)}
        if "\nControls:\n" in text:
            break
    return sorted(ids, key=lambda s: tuple(map(int, s.split(":"))))


def constrained(tools, ids):
    out = []
    for t in tools:
        t = json.loads(json.dumps(t))
        f, props = t["function"], t["function"]["parameters"].get("properties", {})
        if ids and "controlId" in props:
            props["controlId"] = {"type": "string", "enum": ids}
        if ids and "send" in props:
            props["send"] = {"type": "string", "enum": ids}
        if ids and "fields" in props:
            props["fields"] = {"type": "object", "properties": {i: {"type": ["string", "boolean"]} for i in ids}, "additionalProperties": False}
        out.append(t)
    return out


def check(name, raw, tools, ids):
    """None when the call passes, else the reason foxloop (or the id lookup) would give."""
    names = {t["function"]["name"] for t in tools}
    if name not in names:
        return "unknown-tool"
    try:
        args = json.loads(raw) if raw else {}
    except Exception:
        return "invalid-json"
    if not isinstance(args, dict):
        return "invalid-args"
    schema = next(t for t in tools if t["function"]["name"] == name)["function"]["parameters"]
    for r in schema.get("required", []):
        if r not in args:
            return "invalid-args"
    for k, v in args.items():
        p = schema.get("properties", {}).get(k)
        if p is None and schema.get("additionalProperties") is False:
            return "invalid-args"
        if p and "enum" in p and v not in p["enum"]:
            return "invalid-args"
    for k in ID_ARGS.get(name, []):
        if k in args and args[k] not in ids:
            return "unknown-id"
    if name in FIELD_TOOLS and isinstance(args.get("fields"), dict) and any(k not in ids for k in args["fields"]):
        return "unknown-id"
    return None


def call(req):
    body = json.dumps(req).encode()
    t = time.time()
    r = urllib.request.urlopen(urllib.request.Request(base + "/chat/completions", body, {"content-type": "application/json"}), timeout=180)
    d = json.loads(r.read())
    return d, time.time() - t


rows = [json.loads(l) for l in open(src)]
with open(out, "w") as w:
    for n, row in enumerate(rows):
        if n % every:
            continue
        req = row["req"]
        ids = page_ids(req["messages"])
        teacher = json.loads(row["reply"]).get("calls", [])
        for arm in ("as-sent", "enum-ids"):
            tools = req["tools"] if arm == "as-sent" else constrained(req["tools"], ids)
            body = {k: v for k, v in req.items() if k != "model"} | {"tools": tools, "max_tokens": 400}
            try:
                d, s = call(body)
            except Exception as e:
                w.write(json.dumps({"n": n, "arm": arm, "error": str(e)[:200]}) + "\n"); w.flush(); continue
            msg = d["choices"][0]["message"]
            calls = [(c["function"]["name"], c["function"].get("arguments") or "") for c in msg.get("tool_calls") or []]
            reasons = [check(name, raw, req["tools"], ids) for name, raw in calls]
            w.write(json.dumps({"n": n, "arm": arm, "s": round(s, 3), "ids": len(ids), "calls": calls, "reasons": reasons,
                                "content": (msg.get("content") or "")[:300], "teacher": teacher,
                                "usage": d.get("usage"), "timings": d.get("timings")}) + "\n")
            w.flush()
