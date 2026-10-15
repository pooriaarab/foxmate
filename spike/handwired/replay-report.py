"""Sums up replay.py's output per arm.   python3 replay-report.py <out.jsonl>"""
import collections, json, statistics, sys

rows = [json.loads(l) for l in open(sys.argv[1])]
by = collections.defaultdict(list)
for r in rows:
    by[r["arm"]].append(r)
teacher_of = {r["n"]: r["teacher"] for r in rows}


def first_id(calls):
    if not calls:
        return None
    name, raw = calls[0]
    try:
        a = json.loads(raw) if raw else {}
    except Exception:
        return (name, "?")
    return (name, a.get("controlId") or a.get("send") or "")


for arm, rs in by.items():
    ok = [r for r in rs if "error" not in r]
    calls = sum(len(r["calls"]) for r in ok)
    reasons = collections.Counter(x for r in ok for x in r["reasons"] if x)
    no_call = sum(1 for r in ok if not r["calls"])
    same_tool = sum(1 for r in ok if r["calls"] and r["teacher"] and r["calls"][0][0] == r["teacher"][0][0])
    same_target = sum(1 for r in ok if r["calls"] and r["teacher"] and first_id(r["calls"]) == first_id(r["teacher"]))
    secs = [r["s"] for r in ok]
    print(f"{arm}: {len(ok)} requests ({len(rs) - len(ok)} errors), {calls} calls, {no_call} replies with no call; "
          f"rejected calls {sum(reasons.values())} {dict(reasons)}; first call = teacher's tool {same_tool}/{len(ok)}, "
          f"same tool and id {same_target}/{len(ok)}; request s median {statistics.median(secs):.2f} p90 {sorted(secs)[int(0.9 * len(secs))]:.2f}")
