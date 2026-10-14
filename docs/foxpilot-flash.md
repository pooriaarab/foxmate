# foxpilot-flash: a small planner distilled from Saluki

foxpilot-flash is a family of small foxmate planners (foxpilot-flash-4b, -2b, -0.8b), each a Qwen3.5 model
fine-tuned with LoRA on the tool calls of Underdog Saluki 27B. The goal: Saluki's quality on foxbench at the
speed of a 3-4B model, fully local.

## Data rule

Train only on tasks that no benchmark scores:

- foxbench's `train` suite (its own sites; `tasksIn("train")`), and
- MiniWoB++ task types that foxbench's MiniWoB suite does not score, at other seeds.

Never train on a public benchmark that foxbench scores or will score: foxbench core, hard and security+,
the scored MiniWoB types, WebArena, tau2, AppWorld, Gaia2, WebMall, MyPCBench, Mind2Web and the rest.
Two reasons: contamination, and licences (Gaia2 is Llama output, so a model trained on it must carry
"Llama" in its name; AppWorld data must stay encrypted). `scripts/traces.mjs` drops every run of a scored
foxbench task (TR1); keep the MiniWoB type list disjoint from foxbench's scored MiniWoB list by hand.

## Pipeline

1. Collect: run foxbench's train suite (and the unscored MiniWoB types) with Saluki as the planner,
   through `scripts/trace-proxy.mjs`, which logs each planner call.
2. Convert: `scripts/traces.mjs` turns the logs and the score files into a per-call SFT set. It keeps
   only passed, secure runs of the teacher (TR1-TR6 in docs/failure-modes.md).
3. Train on a CUDA GPU VM (`gpu-vm` in pooriaarab/scripts): `scripts/train-planner.sh <set.jsonl>
   Qwen/Qwen3.5-4B <out>/foxpilot-flash-4b`. It trains a LoRA (`scripts/train-planner.py`), merges it
   (`scripts/merge-lora.py`), converts to GGUF (bf16, Q8_0, Q4_K_M), and writes a model card
   (README.md) and NOTICE.
4. Bench: serve the GGUF with llama-server and run foxbench core, hard and security+. The gate: core
   13/13, hard at least 9/10, every attack blocked.

## Licence

Saluki is Apache 2.0, built on Qwen3.8-27B and ISTA-DASLab's GSQ-RCO GGUF (both Apache 2.0); its NOTICE
asks for attribution only. Qwen3.5-4B, -2B and -0.8B are Apache 2.0. A release carries the Apache
licence and the NOTICE that `train-planner.sh` writes.
