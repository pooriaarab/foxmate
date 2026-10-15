#!/bin/bash
# Trains a small foxmate planner on a traces.mjs set, on a CUDA GPU VM (gpu-vm), and builds its GGUF files.
#
#   scripts/train-planner.sh <set.jsonl> <HF base repo> <out dir> [train-planner.py flags]
#   scripts/train-planner.sh set.jsonl Qwen/Qwen3.5-4B ~/runs/planner-4b --epochs 2 --rank 32
#
# 1. A Python venv with torch, transformers and peft; llama.cpp's converter and llama-quantize.
# 2. scripts/train-planner.py: LoRA, prompt masked, best held-out loss kept.
# 3. scripts/merge-lora.py: the adapter merged into the base weights, in the base's own layout.
# 4. GGUF: bf16, then Q8_0 and Q4_K_M (with an importance matrix from the set's own chats), a model card
#    (README.md) and NOTICE for a later release.
#
# Env: LLAMA_CPP (a llama.cpp checkout with build/, default ~/llama.cpp; build it at the commit of the
# llama-server that serves the model), TEACHER (default "Underdog Saluki 27B 1.0").
set -euo pipefail
SET=$1 BASE_REPO=$2 OUT=$3
shift 3
HERE=$(cd "$(dirname "$0")" && pwd)
LLAMA_CPP=${LLAMA_CPP:-$HOME/llama.cpp}
TEACHER=${TEACHER:-Underdog Saluki 27B 1.0}
# Two venvs: training needs a transformers new enough for the base model; llama.cpp's converter pins its own.
VENV=$HOME/planner-venv CONVERT=$HOME/convert-venv
mkdir -p "$OUT"
if [ ! -x "$VENV/bin/python" ]; then
  python3 -m venv "$VENV"
  "$VENV/bin/pip" install -q --upgrade pip
  "$VENV/bin/pip" install -q torch transformers peft safetensors accelerate huggingface_hub flash-linear-attention
fi
if [ ! -x "$CONVERT/bin/python" ]; then
  python3 -m venv "$CONVERT"
  "$CONVERT/bin/pip" install -q --upgrade pip
  "$CONVERT/bin/pip" install -q -r "$LLAMA_CPP/requirements/requirements-convert_hf_to_gguf.txt"
fi
for t in llama-quantize llama-imatrix; do
  [ -x "$LLAMA_CPP/build/bin/$t" ] || cmake --build "$LLAMA_CPP/build" --config Release -j"$(nproc)" --target $t
done
# One copy of each base model on the VM, for every run.
BASE=$HOME/planner-bases/${BASE_REPO//\//_}
"$VENV/bin/hf" download "$BASE_REPO" --local-dir "$BASE" > /dev/null
# SKIP_TRAIN=1 rebuilds the GGUF files from an adapter already in $OUT/adapter.
[ -n "${SKIP_TRAIN:-}" ] || "$VENV/bin/python" "$HERE/train-planner.py" --set "$SET" --base "$BASE" --out "$OUT" "$@" 2>&1 | tee "$OUT/train.log"
"$VENV/bin/python" "$HERE/merge-lora.py" "$BASE" "$OUT/adapter" "$OUT/merged"
NAME=$(basename "$OUT")
"$CONVERT/bin/python" "$LLAMA_CPP/convert_hf_to_gguf.py" "$OUT/merged" --outtype bf16 --outfile "$OUT/$NAME-bf16.gguf"
rm -rf "$OUT/merged"
# An importance matrix from the planner's own chats keeps Q4_K_M close to bf16 on this work.
"$VENV/bin/python" -c '
import json, sys
from transformers import AutoTokenizer
tok = AutoTokenizer.from_pretrained(sys.argv[1])
with open(sys.argv[3], "w") as out:
    for line in open(sys.argv[2]):
        r = json.loads(line)
        out.write(tok.apply_chat_template(r["messages"], tools=r["tools"] or None, tokenize=False, enable_thinking=False))
' "$BASE" "$SET" "$OUT/calibration.txt"
"$LLAMA_CPP/build/bin/llama-imatrix" -m "$OUT/$NAME-bf16.gguf" -f "$OUT/calibration.txt" -o "$OUT/imatrix.gguf" -ngl 99 -c 4096 --chunks 120 > "$OUT/imatrix.log" 2>&1
"$LLAMA_CPP/build/bin/llama-quantize" "$OUT/$NAME-bf16.gguf" "$OUT/$NAME-Q8_0.gguf" Q8_0 > /dev/null
"$LLAMA_CPP/build/bin/llama-quantize" --imatrix "$OUT/imatrix.gguf" "$OUT/$NAME-bf16.gguf" "$OUT/$NAME-Q4_K_M.gguf" Q4_K_M > /dev/null
CALLS=$(wc -l < "$SET" | tr -d ' ')
TASKS=$("$VENV/bin/python" -c 'import json,sys; print(len({json.loads(l)["meta"]["task"] for l in open(sys.argv[1]) if l.strip()}))' "$SET")
# The training data, task by task, so anyone can check a release for contamination.
DATA=$("$VENV/bin/python" -c '
import collections, json, sys
rows = [json.loads(l)["meta"] for l in open(sys.argv[1]) if l.strip()]
teacher = collections.Counter(m["task"] for m in rows if not m.get("on_policy"))
policy = collections.Counter(m["task"] for m in rows if m.get("on_policy"))
print("| Task id (foxbench train suite) | Teacher-run calls | On-policy calls |")
print("|---|---|---|")
for t in sorted(set(teacher) | set(policy)):
    print("| %s | %d | %d |" % (t, teacher[t], policy[t]))
' "$SET")
cat > "$OUT/README.md" <<EOF
---
license: apache-2.0
base_model: $BASE_REPO
tags: [gguf, llama.cpp, tool-calling, agents, foxmate]
---

# $NAME

A foxmate browser-agent planner: $BASE_REPO fine-tuned with LoRA on the tool calls of $TEACHER.

- Training data: $CALLS planner calls on $TASKS tasks of foxbench's train suite (listed below).
- Training: LoRA ($*), prompt masked, merged into the base weights. Files: bf16, Q8_0 and Q4_K_M GGUF.
- Serve: \`llama-server -m $NAME-Q4_K_M.gguf --jinja -fa on -c 32768\`, with foxmate's thinking off.

## Training data

Only foxbench's \`train\` suite: tasks on sites that no scored benchmark uses. No case or page of a scored
benchmark (foxbench core, hard, security+, MiniWoB++, WebGames, WebArena-Infinity, EIA, BrowseSafe, AgentDojo,
tau2 and the rest) is in it. Teacher-run calls come from passed, secure runs of the teacher; on-policy calls
are states the student reached, labelled with the teacher's reply.

$DATA

## Results

foxbench core, hard and security+, and speed per device: fill in from the bench runs before a release.

## License

Apache 2.0. See NOTICE.
EOF
cat > "$OUT/NOTICE" <<EOF
$NAME
A modified version of $BASE_REPO (Apache License 2.0), copyright the Qwen team, Alibaba Cloud.
Trained on outputs of $TEACHER (Apache License 2.0), copyright Underdog (ConwayResearch), itself built on
Qwen3.8-27B (copyright the Qwen team, Alibaba Cloud) and Qwen3.8-27B-GSQ-RCO-GGUF (copyright ISTA-DASLab).
EOF
echo "train-planner: $(ls "$OUT"/*.gguf | tr '\n' ' ')"
