# foxpilot-flash: a small planner distilled from Saluki

foxpilot-flash is a family of small foxmate planners (foxpilot-flash-4b, -2b, -0.8b), each a Qwen3.5 model
fine-tuned with LoRA on the tool calls of Underdog Saluki 27B. The goal: Saluki's quality on foxbench at the
speed of a 3-4B model, fully local.

## Data rule

Train only on foxbench's `train` suite (`tasksIn("train")`, or `tag:train` in the benchmark registry): tasks on
sites that no scored benchmark uses.

Never train on a case, a page or a trace of a benchmark that foxbench scores or will score: foxbench core, hard
and security+, MiniWoB++ (all 125 tasks are scored now), WebGames, WebArena and WebArena-Infinity, EIA,
BrowseSafe, AgentDojo, tau2, AppWorld, Gaia2, WebMall, MyPCBench, Mind2Web and the rest. Two reasons:
contamination, and licences (Gaia2 is Llama output, so a model trained on it must carry "Llama" in its name;
AppWorld data must stay encrypted). `scripts/traces.mjs` keeps only goals of foxbench's train suite (TR1, an allowlist), and
the model card lists every training task id with its call count, so a release can be checked.

## Pipeline

1. Teacher runs: run the train suite with Saluki as the planner, through `scripts/trace-proxy.mjs`, which
   logs each planner call. `scripts/traces.mjs` keeps passed, secure runs (TR1-TR6).
2. On-policy rounds: run the train suite with the student as the planner, and ask the teacher the same
   request at every state; the teacher's reply is the label. Aggregate the labels over rounds (DAgger).
   Leave the trap tasks out of these rounds until the teacher resists every train trap.
3. Train on a CUDA GPU VM (`gpu-vm` in pooriaarab/scripts): `scripts/train-planner.sh <set.jsonl>
   Qwen/Qwen3.5-4B <out>/foxpilot-flash-4b`. It trains a LoRA (`scripts/train-planner.py`), merges it
   (`scripts/merge-lora.py`), converts to GGUF (bf16, Q8_0, Q4_K_M), and writes a model card (README.md) with
   the training data list and a NOTICE.
4. Bench: serve the GGUF with llama-server. First check that the tuned model keeps the untuned model's core
   13/13; then hard and security+. The release gate: core 13/13, hard at least 9/10, every attack blocked.

## Licence

Saluki is Apache 2.0, built on Qwen3.8-27B and ISTA-DASLab's GSQ-RCO GGUF (both Apache 2.0); its NOTICE
asks for attribution only. Qwen3.5-4B, -2B and -0.8B are Apache 2.0. A release carries the Apache
licence and the NOTICE that `train-planner.sh` writes.
