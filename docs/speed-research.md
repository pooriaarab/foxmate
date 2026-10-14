# Speed research: where a task's time goes, and what makes it faster

Measured on 2026-10-13 on an M3 Pro with 36 GB, llama.cpp b10809 (Metal). Everything stays on this computer.
The planner is Underdog Saluki 27B (IQ2 mix, 7.9 GB) on `127.0.0.1:8080`. The fast helper is Qwen3.5-4B Q4_K_M on
`:8082`. foxbench ran in a local Firefox, one task at a time, through a proxy that logs each model call and the
llama-server timings.

A caveat for every time below: a `whisper-cli` job (large-v3-turbo) used the same GPU every few seconds during
most runs. Compare rows from the same table, which ran under the same load. Calls and tokens do not depend on it.

## Where the time goes

foxbench core on main (1899f4b), 13/13, median 80.6 s per task, 1,058 s for the suite:

| Part | Seconds | Share |
|---|---|---|
| Planner prefill (new prompt tokens) | 447 | 42% |
| Planner decode (output tokens) | 319 | 30% |
| Planner other (server, cache) | 53 | 5% |
| Helper (done and settle checks) | 86 | 8% |
| Browser and tools | about 150 | 14% |

- 65 planner calls, 5 per task (median).
- Per call: 383 new prompt tokens (median), 2,919 cached, 32 output tokens.
- Saluki runs at 73 tokens per second for prefill and 9.7 for decode.
- The prompt cache works: the system prompt and the tool list (1,756 tokens) are cached across runs, and each call
  reuses the call before it. Only the newest tool result is new.
- New tokens by tool result: `click` 15,176 (31 calls), `snapshot` 8,426 (13), `fill` 5,568 (8),
  `fill_and_send` 2,766 (9), `act` 543 (4). A `finish` reply follows each task's last send: 13 calls.

The 195 s median seen on Ichabod came from running 2 tasks at a time against the same Saluki. On this Mac,
Saluki IQ2 does not get faster with a batch: one overlapping call cut prefill from 70 to 46 tokens per second and
decode from 8.6 to 4.5. Two tasks at once take about twice as long each.

## Server settings and other models

The first 30 planner requests of the core run, replayed in order on a second server, temperature 0:

| Setting | Seconds | Prefill tok/s | Decode tok/s | Same reply as Saluki |
|---|---|---|---|---|
| Saluki IQ2, as shipped | 380 | 83 | 10.2 | 30/30 |
| Saluki + DFlash2 draft, 4 tokens (acceptance 0.95, 4.8 per step) | 377 | 85 | 10.0 | 30/30 |
| Saluki + DFlash2 draft, 7 tokens (acceptance 0.83, 6.8 per step) | 397 | 85 | 8.8 | 30/30 |
| Saluki + KV cache q8_0 | 361 | 88 | 10.6 | 30/30 |
| Qwen3.8-27B Q4_0 (16 GB) | 430 | 87 | 7.1 | 17/30 (same tool 25/30) |
| Qwen3.8-27B Q4_0 + DFlash2, 4 tokens | 416 | 82 | 8.6 | 17/30 (25/30) |
| Qwen3.6-35B-A3B UD-IQ4_XS (17.7 GB, 3B active) | 105 | 437 | 30.6 | 15/30 (25/30) |
| Gemma 4 26B-A4B IQ4_XS | failed | | | thought for 8,412 tokens in the first reply |

What this shows:

- A dense 27B model prefilled at about 85 tokens per second on this GPU at both quants tested, IQ2 mix and Q4_0.
  Prefill looks bound by compute. The larger Q4_0 is slower, not faster: it decodes at 7.1, not 10.2.
- Speculative decoding does not pay here. DFlash2 drafts are accepted 95% of the time, and MTP (round 3) 96%, and
  decode does not get faster. The likely cause: checking a batch of drafted tokens costs about as much as making
  them one by one on this GPU. This is a reading of the numbers, not a measurement of the check itself.
- A KV cache in q8_0 kept every reply the same in 3 replays. In the paired repeats it was 1-2% faster (361.9 s
  against 369.0 s, and 359.2 s against 363.6 s), which is near the noise of 2 runs with whisper on the GPU. The
  5% in the table comes from the first probe only. The Saluki server on this Mac now runs with `-ctk q8_0 -ctv q8_0`.
- The 3B-active MoE is 3.6 times faster per call: 5.3 times on prefill and 3 times on decode.

## foxbench with the changes

Same conditions in each table: local Firefox, one task at a time.

| Run | Core | Median per task | Suite | Planner calls |
|---|---|---|---|---|
| Saluki, main | 13/13 | 75.9 s | 899 s | 65 |
| Saluki, foxpaw closes a typed date's calendar (P27) | 13/13 | 65.1 s | 831 s | 61 |
| Qwen3.6-35B-A3B, thinking off | 12/13 | 36.3 s | 488 s | 77 |
| Qwen3.6-35B-A3B, thinking off by foxmate (B20), no server flags | 12/13 | 44.4 s | 568 s | 87 |
| Qwen3.6-35B-A3B, B20 and P27 | 12/13 | 41.6 s | 538 s | 80 |

| Run | Hard | Median per task | Suite | Planner calls |
|---|---|---|---|---|
| Saluki, main | 10/10 | 119.2 s | 1,251 s | 82 |
| Qwen3.6-35B-A3B, thinking off | 8/10 | 57.8 s | 672 s | 105 |

- P27: with the calendar open after `fill`, Saluki clicked a day it had typed, or paged months. The four flights
  tasks went from 376 s and 25 calls to 281 s and 20 calls. Their new prompt tokens (the sum of llama-server's
  `prompt_n` over those calls) went from 17,172 to 10,397, a drop of 39%.
- The MoE is about 2 times faster per task (1.7 to 2.1 times in four runs). P27 did not cut its flights calls: it
  takes other detours there (11 to 13 calls). It fails more: contact-billing in core (it says it sent the form;
  the site has no message), and mail-offsite-flight and shop-ambiguous-size in hard. The 4 core traps were blocked
  (4/4). The hard suite has no traps, and security+ did not run on the MoE, so its attack resistance is not measured.
- The MoE writes a sentence before each tool call (58 output tokens per call, Saluki 32). A rule "Reply with tool
  calls only" cut its replay output by 17% and its replay time by 10%.
- Only one large model fits on the GPU at a time. Saluki, the MoE, the helper and whisper together ran Metal out of
  memory, and every server then answered "Compute error" until it was started again.

## Changes that did not help

- Finish in the same reply as the last send (foxloop M10): Saluki never did it, in 26 runs. No call saved.
- Start the finish check beside the planner's last call (foxmate G53): 1 s less per task. The planner call that runs
  beside it gets slower.
- A small model for routine steps (round 2, foxmate `src/route.ts`): the 4B planned 17 of 141 steps, with no gain.
  A faster model for every step, as above, does more.

## Embeddings

Google's newest is EmbeddingGemma 2 (2026-10-06, Gemma 4 based, Apache 2.0): 270M parameters for text, 768
dimensions with Matryoshka cuts to 512, 256 and 128, 8,192 tokens of context. The browser build is
`onnx-community/embeddinggemma-2-ONNX` (q4 text model 175 MB). foxmate already embeds in Firefox with
all-MiniLM-L6-v2 for memory recall.

Speed in Firefox 157 (transformers.js 4.3.1, local files, 64 page lines):

| Model | Backend | Load | One query | Per line in a batch |
|---|---|---|---|---|
| all-MiniLM-L6-v2 q8 | WASM | 0.5 s | 39 ms | 17 ms |
| all-MiniLM-L6-v2 fp32 | WebGPU | 0.7 s | 104 ms | 12 ms |
| EmbeddingGemma 2 q4 | WebGPU | 2.2 s | 212 ms | 30 ms |
| EmbeddingGemma 2 fp32 | WASM | 9.5 s | 647 ms | 247 ms |
| EmbeddingGemma 2 q4 or q8 | WASM | fails | | |

- EmbeddingGemma 2 runs in Firefox only on WebGPU, which a headless Firefox does not have. Its quantized files need
  an operator (`GatherBlockQuantized`) that ONNX Runtime's WASM build lacks. The pipeline also loads the vision
  and audio encoders, so they must be on disk. Its WebGPU q4 scores match fp32 (largest difference 0.015).
- Retrieval of page parts: for each planner call that named a control, the controls were ranked by similarity to
  the goal. The control the planner used next was in the top 5 a third of the time and in the top 10 in 84% of
  calls (median rank 7) with either model. To keep the right control 97% of the time, the planner must still see
  20 controls. A snapshot holds at most 40, so this saves little and drops the needed control too often.
- Tool search: the 12 tools are 4,128 characters and cost nothing after the first call, because they are in the
  cached prefix. A tool list that changes with the goal breaks that cache and costs about 20 s on the first call.
  Tool search starts to pay only when foxplug offers many more tools than now.
- Memory recall: this is where an embedder already runs. EmbeddingGemma 2 scores higher on MTEB than MiniLM, but
  it has about 12 times the parameters (270M against 22M), and it is 5 times slower per query, and needs WebGPU. Keep MiniLM until recall quality is a
  measured problem.

## What would need more work

- A planner that is as good as Saluki and as fast as the MoE. The MoE needs the prose rule and a look at its three
  misses. A Saluki-style tool-calling fine-tune of a 3B-active model would be the strongest lever.
- A Mac with a faster GPU: prefill on a dense 27B is bound by compute, so it scales with the GPU, not the quant.
- Fewer tokens per step: `click` results are the largest part of the new tokens (47%), most of them full pages after
  a navigation.
