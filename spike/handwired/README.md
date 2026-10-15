# Spike: handwired (chenglou/handwired) against foxmate's own code

Research spike for the job fm-handwired, 2026-10-15. Not for merge. The
report is ~/reports/fm-handwired.md on the VM that ran it.

handwired is checked out outside this repo (default ~/ext/handwired-src/repo,
or set HANDWIRED). Run from the repo root after `pnpm build:ext`:

```sh
MOZ_HEADLESS=1 node spike/handwired/capture.mjs /tmp/snapshots.json   # readFrame on 18 real pages, in Firefox
MOZ_HEADLESS=1 node spike/handwired/profile-read.mjs <url>...          # time per readFrame helper
MOZ_HEADLESS=1 node spike/handwired/compare-read.mjs <url>...          # old against fixed section(), equal output
bun spike/handwired/bench.ts /tmp/snapshots.json                       # pageText's pick: JS against the handwired program
node spike/handwired/checks-bench.mjs ~/evidence/runs/teacher-vm/planner.jsonl
python3 spike/handwired/replay.py <planner.jsonl> http://127.0.0.1:18082/v1 /tmp/replay.jsonl --every 3
python3 spike/handwired/replay-report.py /tmp/replay.jsonl
MOZ_HEADLESS=1 node spike/handwired/gpu-probe.mjs                      # WebGPU in the extension page
```

## Results

### pageText's control pick (bench.ts, Bun 1.4.3, this VM's CPU)

program: 300 slots, 12305 built operations, 12298 live, 7499 layers; build 52 ms, compile 41 ms, codegen 24 ms
| page | controls | items | kept | items(), JS (stays in JS) | pick, JS | pick, handwired executor | pick, handwired generated JS | whole pageText, JS | same picks |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| en.wikipedia.org/wiki/Firefox | 300 | 64 | 35 | 50 µs | 12 µs | 484 µs | 154 µs | 549 µs | true |
| news.ycombinator.com/ | 231 | 231 | 40 | 49 µs | 15 µs | 489 µs | 169 µs | 352 µs | true |
| github.com/mozilla-firefox/firefox | 300 | 271 | 40 | 119 µs | 29 µs | 492 µs | 168 µs | 468 µs | true |
| developer.mozilla.org/en-US/docs/Web/API/WebGPU_ | 300 | 114 | 29 | 60 µs | 18 µs | 487 µs | 158 µs | 335 µs | true |
| www.bbc.com/news | 118 | 69 | 32 | 33 µs | 14 µs | 482 µs | 154 µs | 398 µs | true |
| stackoverflow.com/questions/11227809/why-is-proc | 2 | 2 | 2 | 0.64 µs | 0.39 µs | 482 µs | 117 µs | 13 µs | true |
| www.amazon.com/s?k=usb+c+cable | 300 | 234 | 40 | 200 µs | 44 µs | 493 µs | 117 µs | 635 µs | true |
| www.ebay.com/sch/i.html?_nkw=usb+c+cable | 1 | 1 | 1 | 0.13 µs | 0.22 µs | 479 µs | 92 µs | 3.73 µs | true |
| old.reddit.com/r/firefox/ | 4 | 3 | 3 | 0.90 µs | 0.43 µs | 479 µs | 92 µs | 21 µs | true |
| www.python.org/ | 152 | 41 | 16 | 32 µs | 6.76 µs | 481 µs | 99 µs | 374 µs | true |
| docs.python.org/3/library/functions.html | 300 | 239 | 40 | 48 µs | 26 µs | 520 µs | 112 µs | 561 µs | true |
| www.craigslist.org/about/sites | 300 | 66 | 40 | 59 µs | 5.21 µs | 509 µs | 113 µs | 494 µs | true |
| local/article.html | 5 | 5 | 5 | 0.24 µs | 0.80 µs | 506 µs | 93 µs | 15 µs | true |
| local/table.html | 3 | 3 | 3 | 0.18 µs | 0.47 µs | 507 µs | 92 µs | 8.31 µs | true |
| local/settle-cart.html | 1 | 1 | 1 | 0.13 µs | 0.23 µs | 486 µs | 99 µs | 4.55 µs | true |
| local/settle-review.html | 1 | 1 | 1 | 0.13 µs | 0.22 µs | 480 µs | 92 µs | 5.53 µs | true |
| local/dialog.html | 1 | 1 | 1 | 0.13 µs | 0.22 µs | 480 µs | 90 µs | 4.67 µs | true |
| local/notice-bank.html | 2 | 2 | 2 | 0.38 µs | 0.34 µs | 480 µs | 85 µs | 8.97 µs | true |
all picks equal: true

### readFrame with section() fixed (compare-read.mjs, Firefox 158 headless)

| page | old | fixed | same output |
| --- | ---: | ---: | --- |
| en.wikipedia.org/wiki/Firefox | 2088.9 ms | 49.4 ms | true |
| en.wikipedia.org/wiki/List_of_sovereign_states | 1836.3 ms | 41.4 ms | true |
| github.com/mozilla-firefox/firefox | 1980.8 ms | 52.0 ms | true |
| www.amazon.com/s?k=usb+c+cable | 822.9 ms | 55.4 ms | not comparable: the old code alone differs between two reads |
| news.ycombinator.com | 113.4 ms | 11.7 ms | true |
| www.craigslist.org/about/sites | 76.4 ms | 43.5 ms | true |
| docs.python.org/3/library/functions.html | 68.0 ms | 56.1 ms | true |
| www.bbc.com/news | 54.3 ms | 19.2 ms | true |
| developer.mozilla.org WebGPU_API | 34.5 ms | 19.1 ms | true |
| www.python.org | 31.7 ms | 11.7 ms | true |
| e2e/site article, dialog, settle-review | 0.3-0.7 ms | 0.3-0.8 ms | true |

profile-read.mjs on Wikipedia: total 2094 ms, section() 2023 ms of it.

### Tool-call checks (checks-bench.mjs, replay.py on Qwen3.5-4B-Q4_K_M)

323 real tool calls, 0 rejected by checkArgs; JSON.parse + checkArgs + id lookup + repeat key: 0.84 µs per call

- as-sent: 108 requests (0 errors), 107 calls, 1 replies with no call; rejected calls 3 {'unknown-id': 3}; first call = teacher's tool 77/108, same tool and id 76/108; request s median 1.37 p90 2.86
- enum-ids: 108 requests (0 errors), 108 calls, 0 replies with no call; rejected calls 2 {'unknown-id': 2}; first call = teacher's tool 78/108, same tool and id 75/108; request s median 1.47 p90 2.80
