"""LoRA fine-tune of a small planner on a traces.mjs set, on one CUDA GPU.

    python scripts/train-planner.py --set set.jsonl --base <HF dir> --out <dir> [--epochs 2] [--rank 32]

Each line of the set is one planner call: the request, then the teacher's
reply as the last turn. The prompt is masked: only the reply's tokens train.
The chat template renders with thinking off, as foxmate asks llama-server.
About one task in ten is held out (by task name, not by line), so the
validation loss is on tasks the model never trained on. Writes the PEFT
adapter to <out>/adapter and the losses to <out>/train-log.jsonl.
"""
import argparse
import json
import math
import random
import time
from pathlib import Path

import torch
from peft import LoraConfig, get_peft_model
from transformers import AutoModelForCausalLM, AutoTokenizer

p = argparse.ArgumentParser()
p.add_argument("--set", required=True)
p.add_argument("--base", required=True)
p.add_argument("--out", required=True)
p.add_argument("--epochs", type=float, default=2)
p.add_argument("--rank", type=int, default=32)
p.add_argument("--lr", type=float, default=1e-4)
p.add_argument("--max-len", type=int, default=16384)
p.add_argument("--grad-accum", type=int, default=8)
p.add_argument("--seed", type=int, default=0)
args = p.parse_args()
out = Path(args.out)
out.mkdir(parents=True, exist_ok=True)
random.seed(args.seed)
torch.manual_seed(args.seed)

tok = AutoTokenizer.from_pretrained(args.base)
rows = [json.loads(line) for line in open(args.set) if line.strip()]
tasks = sorted({r["meta"]["task"] for r in rows})
held = {t for i, t in enumerate(tasks) if i % 10 == 5} or {tasks[0]}


def encode(row):
    """Token ids and labels: -100 on the prompt, the reply's ids after it. None when the template breaks the prefix."""
    kw = dict(tools=row["tools"] or None, tokenize=False, enable_thinking=False)
    prompt = tok.apply_chat_template(row["messages"][:-1], add_generation_prompt=True, **kw)
    full = tok.apply_chat_template(row["messages"], **kw)
    if not full.startswith(prompt):
        return None
    a = tok(prompt, add_special_tokens=False)["input_ids"]
    b = tok(full[len(prompt):], add_special_tokens=False)["input_ids"]
    ids = a + b
    if len(ids) > args.max_len:
        return None
    return torch.tensor(ids), torch.tensor([-100] * len(a) + b)


train, valid, skipped = [], [], 0
for r in rows:
    e = encode(r)
    if e is None:
        skipped += 1
        continue
    (valid if r["meta"]["task"] in held else train).append(e)
print(f"train {len(train)} calls, valid {len(valid)} calls on {len(held)} held-out tasks, skipped {skipped}", flush=True)

model = AutoModelForCausalLM.from_pretrained(args.base, dtype=torch.bfloat16, device_map={"": 0})
model.gradient_checkpointing_enable(gradient_checkpointing_kwargs={"use_reentrant": False})
model.enable_input_require_grads()
targets = r".*layers\.\d+\.(self_attn\.(q_proj|k_proj|v_proj|o_proj)|linear_attn\.(in_proj_qkv|in_proj_z|out_proj)|mlp\.(gate_proj|up_proj|down_proj))"
model = get_peft_model(model, LoraConfig(r=args.rank, lora_alpha=args.rank, lora_dropout=0.05, target_modules=targets, task_type="CAUSAL_LM"))
model.print_trainable_parameters()

params = [q for q in model.parameters() if q.requires_grad]
opt = torch.optim.AdamW(params, lr=args.lr, weight_decay=0.0)
steps = math.ceil(len(train) * args.epochs / args.grad_accum)
sched = torch.optim.lr_scheduler.LambdaLR(opt, lambda s: min(1.0, (s + 1) / 10) * max(0.0, 1 - s / max(1, steps)))
log = open(out / "train-log.jsonl", "w")


def loss_of(ids, labels):
    # Logits only where the reply is: a full-length logits tensor (16k tokens x a 248k vocabulary) does not fit.
    k = int((labels != -100).sum()) + 1
    logits = model(input_ids=ids[None].cuda(), logits_to_keep=k).logits[0, :-1].float()
    return torch.nn.functional.cross_entropy(logits, labels[-(k - 1):].cuda())


@torch.no_grad()
def evaluate():
    model.eval()
    vals = [loss_of(*e).item() for e in valid]
    model.train()
    return sum(vals) / max(1, len(vals))


model.train()
order = []
t0 = time.time()
tokens = 0
best = evaluate()
print(f"step 0 valid {best:.4f}", flush=True)
log.write(json.dumps({"step": 0, "valid": best}) + "\n")
for step in range(steps):
    total = 0.0
    for _ in range(args.grad_accum):
        if not order:
            order = list(range(len(train)))
            random.shuffle(order)
        ids, labels = train[order.pop()]
        loss = loss_of(ids, labels) / args.grad_accum
        loss.backward()
        total += loss.item()
        tokens += len(ids)
    torch.nn.utils.clip_grad_norm_(params, 1.0)
    opt.step()
    sched.step()
    opt.zero_grad(set_to_none=True)
    rec = {"step": step + 1, "train": total, "lr": sched.get_last_lr()[0], "tok_s": round(tokens / (time.time() - t0))}
    if (step + 1) % 25 == 0 or step + 1 == steps:
        rec["valid"] = evaluate()
        # Keep the adapter with the best held-out loss.
        if rec["valid"] < best:
            best = rec["valid"]
            model.save_pretrained(out / "adapter")
    print(json.dumps(rec), flush=True)
    log.write(json.dumps(rec) + "\n")
    log.flush()
if not (out / "adapter").exists():
    model.save_pretrained(out / "adapter")
print(f"done: best valid {best:.4f}, {steps} steps, {time.time() - t0:.0f} s", flush=True)
