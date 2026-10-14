"""Merges a PEFT LoRA adapter (scripts/train-planner.py) into its Hugging Face base model, in the base's own layout.

    python scripts/merge-lora.py <base HF dir> <adapter dir> <out dir>

For each LoRA module, W += (lora_alpha / r) * B @ A. The adapter may name a
module from the causal-LM class (model.layers.N...) or from the multimodal
class (model.language_model.layers.N...); both map to the base file's own
name. Every other tensor and file is copied as it is, so llama.cpp's
convert_hf_to_gguf.py reads the result like the base model.
"""
import json
import shutil
import sys
from pathlib import Path

import torch
from safetensors.torch import load_file, save_file

base, adapter, out = (Path(p) for p in sys.argv[1:4])
config = json.loads((adapter / "adapter_config.json").read_text())
scale = float(config["lora_alpha"]) / float(config["r"])
lora = load_file(str(adapter / "adapter_model.safetensors"))
index = json.loads((base / "model.safetensors.index.json").read_text())
names = set(index["weight_map"])


def base_name(module: str) -> str:
    """The base weight of a PEFT module name."""
    m = module.removeprefix("base_model.model.")
    for candidate in (m + ".weight", m.replace("model.layers.", "model.language_model.layers.", 1) + ".weight"):
        if candidate in names:
            return candidate
    sys.exit(f"merge-lora: no base weight for the module {module}")


deltas = {}
for key, a in lora.items():
    if key.endswith(".lora_A.weight"):
        module = key[: -len(".lora_A.weight")]
        b = lora[module + ".lora_B.weight"]
        deltas[base_name(module)] = scale * (b.float() @ a.float())

out.mkdir(parents=True, exist_ok=True)
merged = set()
for shard in sorted(set(index["weight_map"].values())):
    tensors = load_file(str(base / shard))
    for name, delta in deltas.items():
        if name in tensors:
            w = tensors[name]
            if tuple(w.shape) != tuple(delta.shape):
                sys.exit(f"merge-lora: {name} is {tuple(w.shape)}, its LoRA delta {tuple(delta.shape)}")
            tensors[name] = (w.float() + delta).to(w.dtype)
            merged.add(name)
    save_file(tensors, str(out / shard), metadata={"format": "pt"})
if merged != set(deltas):
    sys.exit(f"merge-lora: {len(set(deltas) - merged)} LoRA modules found no base weight")
for f in base.iterdir():
    if f.is_file() and not f.name.endswith(".safetensors"):
        shutil.copy2(f, out / f.name)
print(f"merge-lora: merged {len(merged)} weights at scale {scale} into {out}")
