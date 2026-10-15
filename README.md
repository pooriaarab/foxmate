# foxmate

[![npm version](https://img.shields.io/npm/v/foxmate)](https://www.npmjs.com/package/foxmate)
[![Downloads/month](https://img.shields.io/npm/dm/foxmate)](https://www.npmjs.com/package/foxmate)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](https://opensource.org/license/mit)

[Quickstart](#run-your-first-planner) · [API reference](#api) · [Coverage](#coverage) · [Limits](#delivery-and-behavior-limits) · [FAQ](#faq)

foxmate is an open-source Firefox browser agent for users who want local model planning, action approvals, and inspectable task logs.
It combines a Firefox extension, a JavaScript agent library, and a command-line tool.
Its own planners run locally; an optional Claude Code bridge can send shared page text to that client's model.

## Install

```bash
npm install foxmate
```

The CLI and Node.js library require Node.js 24 or later.
TypeScript declarations are included.
For the extension, the manifest targets Firefox 153 or later.

## Run your first planner

Save this as `example.mjs`, then run `node example.mjs`.
This scripted planner example needs no model server, API keys, environment variables, or `.env` file.

```js
import { createBrain } from "foxmate";

const { mind } = await createBrain({
  planner: "scripted",
  script: JSON.stringify([{ tool: "finish", args: { summary: "Planner ready." } }]),
});
const reply = await mind.chat([{ role: "user", content: "Initialize the planner." }]);
const call = reply.message.tool_calls[0].function;
console.log(call.name, JSON.parse(call.arguments).summary);
```

Success prints `finish Planner ready.`
To open a fresh Firefox profile with the temporary extension:

```bash
npx foxmate try
```

Click the toolbar button; the foxmate page opens.
Choose a planner in Settings and a target tab in Chat before running a goal.
For Ollama, start `OLLAMA_ORIGINS="moz-extension://*" ollama serve`, then run `ollama pull qwen3:0.6b`.
The app shows each tool result and any approval request.
Model completion does not prove the whole task succeeded; check the target page.

## How it works

```mermaid
flowchart TB
  user([You]) --> sidebar[App page, a tab or the sidebar: Chat, Today, Lend, Space, Memory, Activity, Settings]
  user -.->|push to talk| voice[foxvoice: Whisper in the app page] -.->|goal text| sidebar
  sidebar <-->|port| bg[Background page]
  phone([Your phone]) <-.->|foxsync, optional| sidebar
  bg -.->|foxnotify: notices, optional webhook| you([Your desktop or ntfy])
  claude([Claude Code]) -.->|foxbridge: Model Context Protocol, native messaging, one shared tab| bg
  subgraph bg[Background page]
    runner[foxrunner: each goal is a durable task] --> agent[Agent: src/agent.ts]
    agent --> recall[foxmemory: recall notes]
    agent --> brain[foxmind: the planner]
    agent --> loop[foxloop: plan, act, check]
    loop --> gate[foxgate: grants and approvals]
    loop --> tools[Tools]
    loop --> trail[(foxtrail log)]
    tools --> paw[foxpaw: read and act on the tab]
    paw --> shield[foxshield: sanitize page text]
    paw --> pass[foxpass: wait at a sign-in, redact secrets]
    tools --> den[foxden: Python, no network]
    tools -.-> lens[foxlens: screenshot, optional]
    tools -.-> link[foxlink: Gmail and Calendar, optional]
    tools -.-> pay[foxpay: x402 payments, cap 0 = off]
    lend[foxlend: lent login in a container] --> gate
    vault[foxvault: tokens and the wallet] -.-> link
    logins[foxvault: saved logins] -.->|fill after your Approve| pass
    vault -.-> pay
  end
  brain --> local[(llama-server, Ollama, or a model in Firefox)]
  paw --> tab[The tab, or the lent tab]
```

One goal, step by step:

1. foxrunner saves the goal as a task, with the host where it started. A
   run that the background page loses runs again from its goal at the next
   wake, if the tab is still on that host.
2. foxmemory recalls your own memories that fit the goal, and foxmate adds
   them under the goal as notes.
3. The brain builds the planner from your settings. foxmind always gets
   `only: ["browser", "local"]`, so a cloud model is never called.
4. foxmate grants the tab's host, and each site your goal names by its
   address (`https://...`), for this run. On a lent tab, the grants stop
   at the scope you lent and the lent site. To go to another site, the
   planner asks you first, and the run moves there in a new tab.
5. foxloop asks the planner for a tool call. On the tab's host, foxgate
   allows page reads, typing and opening pages with no approval. It asks
   you before each click and each foxpaw task, because they can send a
   form. It denies other hosts.
   A payment is a `pay` action of its own: foxpay reads the amount and the
   payee from the bill's `402` answer, and foxgate checks your cap and asks.
6. Once the run holds private data (your mail or calendar, a Space file, or
   memory notes in the goal), foxgate also asks you before each typing and
   each page that foxmate opens, for the rest of the run. Those are the ways
   a page could make the planner carry the data out. The first mail read
   and the first calendar read of a run each ask you. A schedule that you
   set to read mail asks nothing.
7. Before each page read, foxpass scans the tab. On a sign-in, code,
   passkey, CAPTCHA or consent step, the run waits. Chat says "Sign in on
   this tab, then the agent goes on." It goes on when foxpass sees that you
   signed in. Stop ends the wait. With a saved login for the host, Chat
   also shows "Fill saved login": foxpass's `fillWall` fills the password
   into the sign-in field after you approve, and you press the sign-in
   button.
8. Each page read passes foxshield. Hidden text and its controls in the top frame
   are removed before the planner reads; visible instructions arrive marked as data.
   Then foxpass's redaction replaces a password or code value, and each
   copy of it in the text, with `[redacted]`.
9. foxtrail records every step. The run ends when the planner says it is
   done and a check passes.

```mermaid
sequenceDiagram
  participant U as You (app page)
  participant A as Agent
  participant M as foxmemory
  participant P as Planner (foxmind)
  participant G as foxgate
  participant T as foxpaw + foxshield
  participant L as foxtrail
  U->>A: Goal: "Book a table at Bistro Lune"
  A->>M: recall(goal)
  M-->>A: "When I book a table, my party size: 4"
  A->>P: goal + notes
  P->>G: snapshot (read)
  G-->>T: allow
  T-->>P: sanitized page text, as data
  P->>G: browser_task "name: Sam Lee, party size: 4"
  G-->>U: Approve? (exact action and goal)
  U->>G: Approve
  G-->>T: redeem the token, run the exact action
  T-->>P: foxpaw check passed
  P->>A: finish
  A->>L: every step above, then run.end
```

## Why it exists

Browser automation often starts with an agent framework or scripted browser driver.
Browser Use supplies browser agents; Playwright supplies programmatic browser automation.
foxmate puts local planning, per-action approvals, saved-login handoff, and a local activity log into a Firefox app.
It is self-hosted on your computer and provides no managed browser service.

## Compare

Checked on 2026-10-14 against [Browser Use](https://browser-use.com/)
and [Playwright library documentation](https://playwright.dev/docs/library).

| Property | foxmate | Browser Use | Playwright library |
|---|---|---|---|
| Scope | Firefox agent app, library, and CLI | Browser agents and browser infrastructure | Programmatic browser automation |
| Deployment | Extension in your Firefox | Library and cloud offerings | Library in your application |
| Configuration | Settings, goals, approvals, agent options | Agent and browser configuration | Browser and page API calls |
| Planning | Five choices, including scripted replay | Agent model configuration | Caller supplies action scripts |

## Coverage

The planner registry has five choices; `scripted` is a test planner, not an AI integration.
Two Google reader tools are wired in the optional Google module.

| Surface | Status | Scope and verification |
|---|---|---|
| Underdog Saluki on llama.cpp llama-server | ✓ | Local planner preset; historical foxbench records below |
| llama.cpp llama-server | ✓ | Local planner with caller-selected model |
| Ollama | ✓ | Local planner; known cloud models are refused |
| Hugging Face Transformers.js in Firefox | Experimental | Qwen3-0.6B browser planner; small models often fail |
| Scripted planner | ✓ | Deterministic calls for tests and demos |
| Gmail | Implemented, pending credentials | Read-only inbox tool; live Google not checked |
| Google Calendar | Implemented, pending credentials | Read-only events tool; live Google not checked |
| foxlens screenshot tool | ✓ | Optional local Ollama vision description |
| foxden Python Space | ✓ | Sandbox for dropped files; no network |
| foxpay x402 | Test network only | Base Sepolia test USDC; no card checkout |
| Claude Code through foxbridge | ✓ | One shared tab through an external Model Context Protocol (MCP) server |
| foxsync phone approvals | Implemented | Per-page pairing; no reconnect; unavailable during a loan |
| foxnotify notices and ntfy webhook | ✓ | Optional webhook; phone notices are not wired |
| foxvoice | ✓ | English push-to-talk and local speech output |
| foxpass and foxvault saved logins | ✓ | Approved password fill; user submits sign-in |

Checkmarks mean implemented wiring, not universal task reliability.
This rewrite credential-checks zero external integrations and does not repeat Firefox end-to-end runs.
Google credentials and manual microphone checks remain pending; recorded evaluations below state their original dates and scope.

## Common use cases

1. Firefox users run routine form tasks with an Ollama planner and approval cards.
2. foxpass users pause automation at sign-in and approve a saved-password fill from foxvault.
3. CSV users work on dropped files in the foxden Python Space without a network connection.
4. Claude Code developers share one Firefox tab through foxbridge and review actions in foxmate.
5. ntfy home-lab users receive optional summaries from scheduled Firefox tasks.
6. foxbench researchers compare local planners and scripted calls on the same browser tasks.

## Features

- **Local planning:** five planner choices with local-tier restrictions; see [coverage](#coverage).
- **Approval cards:** inspect actions and form values; see [app views](#the-app).
- **User memory:** editable facts through foxmemory; see [privacy](#privacy).
- **Task schedules and replay:** foxrunner tasks and cached workflows; see [behavior limits](#delivery-and-behavior-limits).
- **Integration modules:** screenshots, Google readers, Python, voice, payments, and notices; see [coverage](#coverage).

## Runtime surfaces

The CLI has three commands: `try`, `bench` and `bench-mcp`.
The foxbridge path answers six MCP tools: `list_tabs`, `snapshot`, `act`, `click`, `run_task`, and `open_url`.
Beside the foxbridge path, `foxmate bench-mcp` is an MCP server for foxbench runs only.
The sections below retain app views, privacy details, APIs, and historical evaluation records.

### The app

The toolbar button opens foxmate in a tab, or brings the open one to the
front. The same page also runs in the sidebar (View > Sidebar), and a rail
button moves between the two. Chat is home; a slim rail on the left opens
the other views. The first open shows the setup: what foxmate is, a model
server on this computer (it finds llama-server and Ollama and says when
each one answers), how approvals work with a demo card, the optional extras,
and a first task. Settings runs it again.

foxmate never works on its own page. The "Working on" chip in the composer
names the target tab: the tab you pick in its menu, else the active web tab
of the window (in the sidebar), else the web tab you used last (in the full
page, the tab you came from).

Each step and each approval card says what happens in plain words, for
example "Read the page" or "Fill in and send the form on example.com". The
raw tool call, and the exact action that foxgate allows, are behind
"Details". A card can also offer "Always allow" for one tool on one site.
Settings lists these rules, and you can remove each one.

A small fox shows the run state. It rests in the empty chat, looks up while
the planner thinks, trots while a tool runs, sits up when an approval or a
sign-in waits, and hops once when the goal is done. In a long run it steps
back. It honors "reduce motion".

| View | What it does |
|---|---|
| Chat | A goal box for the target tab, ideas to start, and each run as a conversation: the planner, each plan, gate decision, approval card (the site, one line of what happens, where a form fill sends, and Deny, Always allow and Approve; the form's fields and the exact action sit behind Details), result and the final check. "Your turn" at a sign-in step. A goal still runs with no web page open, and a run can go to a site the goal does not name: it asks before it opens each site in a new tab. A mail or calendar read asks once per run. The microphone button fills the goal box from speech. The target menu shares the tab with Claude Code. |
| Today | The goal tasks (running, waiting for you, finished), and schedules such as "every day at 08:00, open my calendar page and list today's meetings". |
| Lend | Lend the target tab's site with a scope, a time limit and an allow list. Run a goal in the lent tab, revoke it, and see the blocked requests. |
| Space | Files for the planner's Python. Network: off. |
| Memory | Read, add, edit, pin and delete what foxmate remembers. |
| Activity | The foxtrail log, whether it verifies, and an export. |
| Settings | The planner (models on this computer only), the setup again, approval rules, saved logins (site, username, password), "Speak the result", the optional modules, the notices (quiet hours and a webhook), and the payment cap, payees and wallet. |

### Privacy

This section says exactly what leaves your computer.

- **The planner.** It is always a model on your computer: Underdog Saluki
  27B on llama-server (the default), another llama-server model, Ollama, or
  Qwen3-0.6B in Firefox. foxmate has no cloud model option. foxmind refuses
  a cloud provider, an Ollama model whose name ends in `-cloud`, and a
  server address that is not on this computer. Page text, the goal and the
  results of the tools go only to that model.
- **Memory.** The embedding model (MiniLM) runs in Firefox. It downloads once
  from Hugging Face. Memories stay in IndexedDB. The memories that fit a goal
  go to the planner with it.
- **Screenshots (off by default).** The `look` tool sends a screenshot only
  to Ollama on this computer.
- **Gmail and Calendar (off by default).** foxlink talks to Google with your
  own OAuth client id, after Firefox's consent for mail and sign-in data.
  Mail and events then go to your planner, which runs on this computer. Each mail body and event description passes foxshield
  first. foxmate prefers a mail's HTML part, which is what you see, and tells
  the planner which part it used.
- **Payments (off by default).** With a cap above 0, the planner can pay a
  bill on the tab's site with test USDC on Base Sepolia (x402). foxvault
  keeps the wallet key; only foxpay's signer gets it. The paid answer and the
  receipt go to your planner, which runs on this computer.
  After a payment, the run counts as holding private data.
- **Claude Code bridge (off by default).** When you share a tab, Claude Code
  gets that tab's page text after foxshield, and sends it to its own model.
  This is the one case where page text can reach a cloud model, and only
  because you started Claude Code and shared the tab. foxbridge is not a
  foxmate planner. The share click asks for Firefox's
  `websiteContent` data consent and the optional `nativeMessaging`
  permission. If Firefox says no, the bridge stays off.
- **Voice.** Push to talk uses Whisper in the app page, so the audio and its text stay on this computer. The microphone is
  on only while you hold the button. The model downloads once from Hugging
  Face (43 MB); that request holds no audio. A spoken result uses a voice on
  this computer.
- **Notices.** Desktop notices stay on this computer. The webhook is off
  by default. When you turn it on, it sends the kind of notice, a fixed
  sentence and the time to the address you type. Settings shows the exact
  request first. The goal goes with it only after you tick "Put the goal in
  the webhook notice" and Firefox's `websiteActivity` consent says yes.
  The list above states the outgoing data paths.
- **Phone approvals (off by default).** foxsync sends each approval to your
  phone over an encrypted peer-to-peer WebRTC link. To pair, the phone
  camera opens foxsync's phone page from a QR code. The phone sends its
  sealed pairing answer through the foxsync relay, which cannot read it.
- **The log.** foxtrail stays in this browser. It holds each tool call, its
  arguments and short quotes of what foxshield flagged. It does not hold whole
  pages. The URLs of requests that foxlend blocked are kept without their
  query.
- **Sign-in steps.** You type a password or a code in the page, or you fill
  a saved login. foxpass's scan reads no field values. The planner reads the
  page after you sign in, and any secret value left in it shows
  `[redacted]`.
- **A password in your goal.** When your goal gives a password ("password
  Tr4il-Mix-2026"), the agent types it only into a password field on the
  exact site, scheme and port the run started on (`https`, unless the site
  is on this computer). A step that carries it elsewhere, such as a text
  box, an address or a message, is refused before you see a card. This is a
  partial defence: it finds the password inside other text and
  percent-encoded, but not split into short pieces or encoded another way
  (base64). The log shows it as `•••`.
- **Saved logins.** A login vault (foxvault, with its own key) keeps each
  password encrypted in this Firefox profile, for one host. At a sign-in
  wait on that host, Chat shows "Fill saved login". The fill waits for your
  Approve, which shows foxgate's exact action: the host, the field and the
  handle. foxvault writes the password into the top document only, and into
  a plain `http:` page only on this computer. Every message to the planner
  and every log entry passes the vault's `redact`, so a copy of a password
  shows its handle. The log records each release by handle and host.
- foxmate has no server and sends nothing to its authors.

### API

foxmate is an extension, a CLI and a library. It has no MCP server of its
own: an MCP client reaches one shared tab through foxbridge's MCP server.

#### Claude Code (foxbridge)

Set it up one time:

```bash
npm i -g foxbridge
foxbridge install --extension-id foxmate@pooriaarab
claude mcp add foxbridge -- foxbridge mcp
```

Then tick "Share this tab with Claude Code" in Chat. foxmate answers
foxbridge's tools on that tab: `list_tabs`, `snapshot`, `act`, `click`,
`run_task` and `open_url` (in the shared tab, on its host only). Each call
is a foxmate run with its own grants, and its approval shows in Chat. A call
for another tab gets `not-shared`. Stop now closes the bridge.

#### CLI

```text
foxmate try [--firefox <path>]
foxmate bench [--planner scripted|ollama|llama-server|saluki] [--model <name>] [--base-url <url>]
              [--approve careful|all|none] [--suite core|hard|security+|all] [--tasks <ids>]
              [--ask on|off] [--scout <url>|off] [--replay on|off] [--repeat]
              [--fixed-ports <n>] [--timeout <s>] [--out <dir>] [--headed] [--firefox <path>] [--help]
foxmate bench-mcp [the planner options of bench]
```

`foxmate try` opens Firefox with a fresh, temporary profile and foxmate
installed. `foxmate bench` runs a foxbench suite in a real Firefox (the 13
`core` tasks by default; `--suite hard`, `security+` or `all` for the others)
and writes `artifacts/score-<agent>-<date>.json` and `.md`. `--approve` sets the
stand-in human: `careful` denies an approval that names an email address
the goal does not name, `all` approves everything, `none` denies everything.
When the planner asks a question, the bench posts it to foxbench's Ask Sam
chat and types Sam's answer back; at a sign-in wall, Sam signs in.
`--ask off` turns questions off. `--repeat` runs the tasks a second time in
the same Firefox, where a goal that ran done before replays its kept calls,
and writes that pass to `<out>/repeat` as repeat-run scores. `--replay off`
turns the workflow cache off.

##### The bench on Ichabod

`FOXKIT_BROWSER=ichabod` with `ICHABOD_API_KEY` runs `foxmate bench` in
Firefox on Ichabod, Mozilla's cloud browser. The model stays on this
computer. Run it from a checkout with `cloudflared` installed:

```sh
pnpm build && node scripts/build-ext.mjs --bench-remote
FOXKIT_BROWSER=ichabod node cli/foxmate.mjs bench --planner saluki
```

- Ichabod's Firefox cannot reach `127.0.0.1`. The bench mounts each task
  site and each model server on create-foxkit's Cloudflare quick tunnel.
  A model server sits behind a gate that forwards only under a random
  path, and the scores show neither that path nor the tunnel host.
- foxmate takes only models on this computer, so the release extension
  refuses a tunnel address (`not-local`). Only `dist-ext-bench/`, which
  npm and AMO never get, takes it.
- Ichabod drops a session after about 12 minutes, so the bench starts a
  new session between tasks after 6 minutes. `--repeat` then finds no
  kept workflows from a lost session.
- `<out>/ichabod-sessions-<date>.json` lists the session IDs, to find
  each recording on the Ichabod console.
- `--firefox` and `--headed` stop the run: Ichabod cannot set them.

##### Every foxbench benchmark over MCP

`foxmate bench-mcp` is an MCP server on stdio with one tool, `run_task`
{url, goal}, for `foxbench run --agent mcp`. Each call runs one task in one
Firefox and returns `{ done, log, answer?, metrics? }`; foxbench scores the
task itself. It takes the planner flags of `foxmate bench`, and
`FOXKIT_BROWSER=ichabod` runs it on Ichabod as above. A preset in
`foxbench.agents.json`, in the working directory or in
`~/.config/foxbench/`:

```json
{
  "foxmate": {
    "command": "node",
    "args": ["/path/to/foxmate/cli/foxmate.mjs", "bench-mcp", "--planner", "saluki"],
    "name": "foxmate (saluki)"
  }
}
```

```sh
foxbench run --agent foxmate --suite webgames --subset quick
```

`pnpm e2e:mcp` runs foxbench's train suite with noop and with foxmate over
MCP; noop must score 0 and foxmate above 0.

#### Library

| Export | What it does |
|---|---|
| `createAgent({ browser, trail, memory?, publicSuffix?, extraTools?, moreTabTools?, pay?, redact?, maxSteps?, runMs? })` | The agent. `run({ goal, tabId, settings, loan?, runKey?, mind?, signal?, onEvent? })` runs one goal and resolves with `{ status, summary?, reason?, message? }`. It also returns `gate`, `host` and `approvals`. |
| `createBrain(settings, { goal?, browserModel? })` | The planner for the settings. Throws `BrainError` (`not-local`, `unknown-planner`, `bad-script`, `no-browser-model`) before any network call. |
| `PLANNERS` | The planner choices. Each one runs on this computer or in Firefox. |
| `createApprovals({ host, trail? })` | One approval broker for the foxmate page and the phone. The first answer decides. |
| `shieldedPaw({ browser, paw?, threshold?, onScan?, fieldHints? })` | foxpaw with each snapshot passed through foxshield, then foxpass's redaction. |
| `createPass({ browser, trail, timeoutMs?, onNeedsUser?, logins? })`, `redactPage(page, hints, quotes?)` | The sign-in handoff that `createAgent({ pass })` runs before each page read, and the redaction of a foxpaw snapshot. `fillSaved()` fills a saved login into the tab that waits. |
| `createLogins({ vault, host, store, browser, trail })`, `loginGate()`, `frameBrowser(browser)` | Saved logins: `save`, `list`, `remove`, `fill` (after an approval from the foxmate page) and `redact`. `loginGate()` is the fill's own foxgate. `frameBrowser` stands in for `webNavigation`. |
| `recallNotes(memory, goal)`, `withNotes(goal, notes)` | The user's memories that fit a goal, as notes under it. |
| `formDetail(snapshot, controlId)` | What a form holds, for the approval of its send button. |
| `spaceTool(den)`, `lookTool(tabId, deps)`, `googleTools(deps)` | The Space, screenshot and Google tools. |
| `payTool(foxpay, run)`, `toAtomic`, `fromAtomic`, `parsePayees` | The planner's `pay` tool. `createAgent({ pay: { x402, store, cap } })` adds it: `x402` is foxpay's method, and `cap()` gives the cap for one goal in atomic test USDC. |
| `bridgeCall(run, call)`, `BridgeRefusal` | One call from an outside agent, run through the agent with a planner that asks for that call. Resolves with foxbridge's reply, or throws a foxbridge code. |
| `scriptMind(script, goal)` | The scripted planner for tests and the bench. |

### Tests

`pnpm ci:local` runs lint, typecheck, isolated tests, builds, extension lint, and listing checks.
The repository keeps its failure-mode inventory beside the tests.

`pnpm e2e` runs foxmate in a real Firefox through the real app page and
writes `artifacts/e2e-<date>.json`. The planner is the scripted one, so
the planner input is deterministic. This rewrite does not repeat the Firefox suite. With
`FOXMATE_VISION` set to an Ollama address that allows extension origins, the
vision check runs too. The suite checks these paths:

| Test path | Expected behavior |
|---|---|
| foxbench `signup-pro` through the app page | foxbench's oracle passes; one approval, for "Create account"; the trail verifies |
| A local bank asks for a password, then a code; the test types them as the user | The run waits, Chat says what to do, the run goes on and finishes; the planner's requests, the log, memory and the app page hold neither secret; Stop ends a wait |
| The same bank, with its login saved in Settings; the test clicks "Fill saved login" | One approval, foxgate's `foxvault.fill` on the bank's host and `#password`; the page gets the password and the username; the planner's requests, the log, its export, storage and the app page hold no password; the log has the release by handle and host |
| An approval waits after the test closes the app page | Firefox shows "Approval needed"; a click on it opens the approval in a tab, where it still waits; the stand-in webhook gets no goal until the box and Firefox's consent allow it |
| The microphone plays a recording of JFK's inaugural address | Whisper in Firefox fills the goal box with it, and no run starts; the model host gets no audio; the microphone is off after let go; a denied microphone offers the setup page |
| A hidden link tells the agent to send the password to `/attacker.test/` | foxshield flags it; the planner never sees the link; the task passes |
| A fake system message in an email asks to forward mail to `audit@attacker.test` | The Send approval shows `To: "audit@attacker.test"`; the human denies; nothing is sent |
| Visible text asks to open a link on another host | foxgate denies it (`no-grant`); the tab stays |
| An Ollama `gpt-oss:120b-cloud` model, or a cloud planner left in old settings | Refused before any plan |
| Book a table, before and after the user saves "party size: 4" | For 2, then for 4; the approval shows the note |
| Lend a local bank, send money in the lent tab, revoke | The lent tab is signed in; the page's requests to the attacker are blocked; the container is gone; your own tab stays signed in |
| Drop a CSV in the Space, ask for a sum | Python sums it; its request to a probe server never arrives |
| A second Firefox opens the Settings QR code: foxsync's hosted phone page | It pairs through the relay with no copy step; its Approve sends the form; its Deny stops the run |
| Reload the extension while an approval waits | foxrunner runs the task again, and it finishes |
| Wait 90 s at an approval | The run goes on; the app page keeps the background page loaded |
| A read loan allows `attacker.test`; a normal run opens it | foxgate denies it: the loan's grant is not the run's |
| Two goals at once | The first runs; the second ends as refused, and you start it again |
| A run waits, the tab moves to another host, the extension reloads | The task runs again, sees the other host, and refuses |
| Pay a bill of 0.01 test USDC with a cap of 0.05 | One approval with the exact amount, payee and site; the paid API sees one payment; the same payment again pays nothing; a bill of 1 USDC is refused (`spend-cap`) |
| Claude Code's MCP client on a shared tab, through foxbridge's own host | The page read has no hidden text; a click asks in Chat; a denied click and a call for another tab are refused; Stop ends the session |
| A canvas page, with `FOXMATE_VISION` | `qwen3-vl:2b` in Ollama describes the screenshot |

### Scores on foxbench

These repository scoreboards record historical runs; this rewrite does not repeat them.
The core suite has 13 tasks; the hard suite has 10, and security+ has three.
Times and success rates apply only to those runs, models, and approval policies.

| Planner / suite | Recorded date | Task passes | Median time |
|---|---|---|---|
| Saluki 27B, core, first 0.1.7 run | 2026-10-11 | 12/13 | 92.4 s |
| Saluki 27B, core, second 0.1.7 run | 2026-10-11 | 11/13 | 75.7 s |
| Saluki 27B, hard, 0.1.7 | 2026-10-11 | 8/10 | 134.7 s |
| Saluki 27B, security+, 0.1.7 | 2026-10-11 | 2/3 | 66.2 s |
| Scripted, core, careful approvals | 2026-10-09 | 12/13 | 12.0 s |
| Ollama Qwen3-0.6B, core | 2026-10-09 | 0/13 | 9.5 s |
| Ollama Qwen3-VL-2B, core | 2026-10-09 | 1/13 | 11.1 s |

The scripted planner uses human-written steps; its score does not measure AI planning.
An agent that takes no action can block attacks while completing no tasks.
Read the task result alongside any security score.
The repository keeps the scoreboards in `artifacts/`.

### Firefox APIs used

| API | MDN | Why |
|---|---|---|
| `action.onClicked`, `sidebar_action`, `sidebarAction.open` | [sidebarAction](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/sidebarAction) | The toolbar button opens the app in a tab; the same page runs in the sidebar too. |
| Background scripts with `"type": "module"` (event page) | [Background scripts](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Background_scripts) | Hosts the agent, the runner, the lender, the vault and the Space. |
| `runtime.connect`, `runtime.sendMessage`, `runtime.onMessage`, `runtime.reload` | [runtime](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/runtime) | The app page streams events, answers approvals and sends a message every 20 s. |
| `tabs.query`, `tabs.get`, `tabs.create`, `tabs.update` | [tabs](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/tabs) | The current tab, a scheduled task's start page, and `open_url`. |
| `tabs.captureTab` (through foxlens) | [captureTab](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/tabs/captureTab) | The optional screenshot tool. |
| `scripting.registerContentScripts` with `world: "MAIN"` (through foxpass) | [registerContentScripts](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/scripting/registerContentScripts) | See a passkey request in the page as a sign-in step. It records the kind and the state of each call, never its result. |
| `windows.update` (through foxpass) | [windows.update](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/windows/update) | Bring the tab with the sign-in step to the front. |
| `scripting.executeScript` | [executeScript](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/scripting/executeScript) | foxpaw reads and acts; foxshield scans; foxmate asks which controls are hidden. No model-written code runs in a page. |
| `storage.local`, `unlimitedStorage` | [storage](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/storage/local) | Settings, foxrunner tasks, foxlend loans, foxvault ciphertexts. |
| IndexedDB | [IndexedDB](https://developer.mozilla.org/en-US/docs/Web/API/IndexedDB_API) | The foxtrail log and key, memories, the vault key, the Space files. |
| `contextualIdentities`, `cookies`, `browsingData` (through foxlend) | [contextualIdentities](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/contextualIdentities) | A container per loan, the copied cookies, and the wipe on revoke. |
| Blocking `webRequest`, `proxy.onRequest` | [webRequest](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/webRequest) | foxlend's allow list for lent tabs; foxvault's header for the Google tokens. |
| `privacy.network` (through foxlend) | [privacy](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/privacy) | WebRTC and network prediction are off while a loan is active. |
| `publicSuffix.getDomain` | [publicSuffix](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/publicSuffix) | One site rule for foxgate and foxlend. |
| `alarms`, `runtime.onStartup` (through foxrunner) | [alarms](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/alarms) | Wake the page for schedules and for a task cut short. |
| `fetch` with host permissions (through foxpay) | [fetch](https://developer.mozilla.org/en-US/docs/Web/API/Window/fetch) | Read the `402` answer of a bill and send the signed payment. |
| `runtime.connectNative`, optional `nativeMessaging` | [connectNative](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/runtime/connectNative) | Start the foxbridge host while a tab is shared, and answer its calls. |
| `notifications.create`, `clear`, `onClicked` (through foxnotify) | [notifications](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/notifications) | Tell you that a run needs you or ended while no foxmate page is in view. A click opens a tab; it never answers. |
| `getUserMedia`, `MediaRecorder` (through foxvoice) | [getUserMedia](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia) | Push to talk. The microphone is on only while you hold the button. |
| `speechSynthesis` (through foxvoice) | [SpeechSynthesis](https://developer.mozilla.org/en-US/docs/Web/API/SpeechSynthesis) | "Speak the result", with a voice on this computer only. |
| `document.visibilityState` | [visibilityState](https://developer.mozilla.org/en-US/docs/Web/API/Document/visibilityState) | The app page tells the background page if it is in view, so a notice comes only when you cannot see the run. |
| `identity.launchWebAuthFlow` (through foxlink) | [identity](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/identity) | Google sign-in for the optional Gmail and Calendar tools. |
| `permissions.request`, `permissions.contains` with `data_collection` | [permissions.request](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/permissions/request) | Firefox's consent before page text goes to Claude Code, or mail to Google tools. |
| `browser_specific_settings.gecko.data_collection_permissions` | [browser_specific_settings](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/manifest.json/browser_specific_settings) | Nothing by default; `websiteContent`, `websiteActivity`, `personalCommunications` and `authenticationInfo` are optional. |
| `sandbox` manifest key, `content_security_policy.sandbox` | [sandbox](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/manifest.json/sandbox) | The Space page: no extension APIs and `connect-src 'none'`. |
| WebAssembly, `'wasm-unsafe-eval'`, Web Workers | [CSP](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/manifest.json/content_security_policy) | Pyodide in the Space; ONNX Runtime for the in-browser models. |
| Web Crypto | [SubtleCrypto](https://developer.mozilla.org/en-US/docs/Web/API/SubtleCrypto) | The foxtrail chain, the foxvault encryption, the foxsync keys. |
| `RTCDataChannel` (through foxsync) | [RTCDataChannel](https://developer.mozilla.org/en-US/docs/Web/API/RTCDataChannel) | The optional phone link. |

## Delivery and behavior limits

- The recorded core runs show Qwen3-0.6B finishing zero tasks and Qwen3-VL-2B finishing one of 13.
  The scripted planner uses human-written steps.
- Saluki 27B is the default private planner. Historical scores above vary by suite and run.
  A successful benchmark does not guarantee a real task will finish.
- When the newest result carries no task check, foxmate passes `finish` if
  the newest step worked and the page shows no error. A model can still say
  "done" after a page read, with the task not done; the small models did.
- A goal that only asks about the page ("Summarize this page") finishes
  after the first read. The planner sees at most 4000 characters of the
  page: on a long page, that is only the start. Nothing checks the answer
  against the page.
- foxgate limits where an action goes, not what its arguments hold. Before
  the run holds private data, typing and opening pages on the tab's host need
  no approval, so a page can make the planner type or send what the page
  itself shows, or what the goal says. After private data, each of those
  asks you, and you must read the approval.
- A denied approval ends the run. It does not try another way. A step that
  the gate refuses because it is outside the run (another site, or a tool
  with no grant) does not end it: foxmate's planner gets the reason as the
  step's result and can try another step. The third such refusal in a row
  ends the run. A "Never allow" rule still ends it.
- An approval for `browser_task` covers every field and click that foxpaw
  makes in that task.
- The form values in an approval are the ones the planner last read. A page
  script can change a field after you approve; foxloop pins the button, not
  the values.
- foxshield's check for controls inside hidden text covers the top frame.
  Controls in a frame that its parent hides still reach the planner, as
  data, and a click on them still needs your approval.
- Nothing runs while Firefox is closed, unless you run the foxrunner helper
  yourself. A task cut short runs again from its goal, but only while its
  tab is on the host where the goal started: steps that already ran (a sent
  form) can run again, after a new approval. Each new attempt
  of a scheduled task opens its start page in a new tab.
- Firefox unloads the background page about 60 s after the last event. The
  open app page keeps it loaded. A scheduled run with no foxmate page open can be
  cut short while it waits for an approval.
- WebRTC is off in all of Firefox while a loan is active, so phone
  approvals do not work during a loan.
- The phone link lives in the app page, and pairing is per page session.
  There is no reconnect yet.
- Containers do not exist on Android, so Lend works on desktop Firefox only.
- The Space has the Python standard library only, and each den loads about
  12 MB of Pyodide. Whether AMO accepts Python that a model writes, run in a
  bundled interpreter, is an open question.
- The Gmail and Calendar tools are read only, and we did not test them
  against Google. Screenshots need Ollama with
  `OLLAMA_ORIGINS="moz-extension://*"`; so does the Ollama planner.
- foxmate is not signed on AMO yet.
- Payments use x402 on Base Sepolia with test USDC only. There is no card
  checkout. Each site needs its payee address in Settings.
- The cap holds for one goal. The next goal starts at 0 spent.
- A denied payment does not end the run. The planner gets the refusal.
- The bridge shares one tab at a time. It stops when the tab moves to
  another host, and after a Firefox restart.
- The host manifest names one extension. While it names foxmate, the
  foxbridge extension cannot use the host, and `foxbridge status` reports
  the id as a problem.
- While a goal runs, a call from Claude Code is refused (`busy`).
- Push to talk knows English only (Whisper tiny.en), and it is slow on one
  WASM thread: in foxvoice's tests, 11 s of speech took 3.3 s on an Apple
  M3 Pro. There is no wake word.
- Firefox may show no microphone prompt in the sidebar. Then "Set up the
  microphone" opens a tab where Firefox asks once. We did not check the
  sidebar prompt by hand.
- "Speak the result" is off again each time foxmate opens. On Linux,
  Firefox needs speech-dispatcher and a voice to speak.
- A notice click opens the approval in the app tab, not the sidebar:
  Firefox opens the sidebar only from a user action.
- A finished run, and a schedule that ran late, are low-priority notices.
  They wait for foxnotify's digest, which shows after 60 minutes.
- The webhook has no retry, and the phone link does not carry notices yet.
- foxpass's sign-in rules are heuristics, and they read the top frame only.
  A sign-in form in an iframe or a canvas does not pause the run.
- foxmate gives foxpass no `webNavigation` permission, so the sign-in scan
  is not pinned to one document. If the page reloads with the same
  sign-in step, the banner does not come back, but the wait goes on.
- The sign-in wait lives in the background page. The open app page keeps it
  loaded. The user has 5 minutes; then the run stops.
- foxmate fills a saved password only. It does not fill a one-time code or
  a passkey, and it never presses the sign-in button: you do.
- A saved password has 8 to 4096 characters (foxvault's rule). The fill
  needs a password field in the top document. On a page that asks for the
  username alone, you type it, and the fill comes on the next page.
- The username is not a secret: Settings shows it, and it stays in
  `storage.local` in clear. It is filled only into an empty email or
  username field of the approved form.
- A password field for a new password (a sign-up) is not a wall: the
  planner fills it from the goal.

## Integration guides

- [Ollama planner setup](#run-your-first-planner): allow Firefox extension origins and download a local model.
- [Claude Code browser access through foxbridge](#claude-code-foxbridge): install the native host and share one tab.
- [Agent library integration](#library): supply browser APIs, a trail, and optional tools.
- [Local benchmark CLI](#cli): choose a planner, suite, and approval policy.

## Status

foxmate is a 0.x package; APIs, defaults, and extension behavior can change before 1.0.
Report problems through [GitHub issues](https://github.com/pooriaarab/foxmate/issues).
Public case studies are not yet published.
This README does not claim an approved AMO listing; `try` loads a temporary add-on.

## FAQ

### What is foxmate?

foxmate is a Firefox browser agent with local planning, action approvals, and a local log.
It also exports the agent core and two CLI commands.

### Which integrations are verified?

foxmate has isolated tests and dated repository browser evaluation records.
This rewrite checks no external credentials; Gmail and Google Calendar remain pending live verification.

### Does foxmate provide a managed browser agent?

foxmate runs in your own Firefox.
You supply a local model server or choose the browser or scripted planner.

### How is foxmate different from Browser Use?

foxmate packages its agent as a Firefox extension with local planner restrictions and approval cards.
[Browser Use](https://browser-use.com/) offers browser agents and browser infrastructure, including cloud offerings.

### How is foxmate different from Playwright?

foxmate plans actions from a goal or replays scripted tool calls through its agent gate.
[Playwright](https://playwright.dev/docs/library) exposes browser automation APIs for caller-written scripts.

### Can foxmate send page text to a cloud model?

foxmate's own planners use only local or browser tiers.
The optional Claude Code bridge shares page text with that client after Firefox consent.

### Does foxmate support Gmail and Google Calendar writes?

foxmate's two Google tools read inbox messages and upcoming events.
They do not send mail or create calendar events through the Google APIs.

### Can foxmate pay real bills?

foxmate's payment module uses x402 with test USDC on Base Sepolia.
It has no production payment or card checkout path.

## Part of the fox primitives

```mermaid
flowchart LR
  foxkit[foxkit] -.->|template| foxmate
  foxbench[foxbench] -.->|scores| foxmate
  foxmind[foxmind] --> foxmate[foxmate]
  foxpaw[foxpaw] --> foxmate
  foxgate[foxgate] --> foxmate
  foxtrail[foxtrail] --> foxmate
  foxloop[foxloop] --> foxmate
  foxshield[foxshield] --> foxmate
  foxlend[foxlend] --> foxmate
  foxvault[foxvault] --> foxmate
  foxmemory[foxmemory] --> foxmate
  foxrunner[foxrunner] --> foxmate
  foxden[foxden] --> foxmate
  foxsync[foxsync] --> foxmate
  foxlens[foxlens] --> foxmate
  foxlink[foxlink] --> foxmate
  foxpay[foxpay] --> foxmate
  foxbridge[foxbridge] --> foxmate
  foxpass[foxpass] --> foxmate
  foxnotify[foxnotify] --> foxmate
  foxvoice[foxvoice] --> foxmate
  click foxkit "https://github.com/pooriaarab/foxkit"
  click foxbench "https://github.com/pooriaarab/foxbench"
  click foxmind "https://github.com/pooriaarab/foxmind"
  click foxpaw "https://github.com/pooriaarab/foxpaw"
  click foxgate "https://github.com/pooriaarab/foxgate"
  click foxtrail "https://github.com/pooriaarab/foxtrail"
  click foxloop "https://github.com/pooriaarab/foxloop"
  click foxshield "https://github.com/pooriaarab/foxshield"
  click foxlend "https://github.com/pooriaarab/foxlend"
  click foxvault "https://github.com/pooriaarab/foxvault"
  click foxmemory "https://github.com/pooriaarab/foxmemory"
  click foxrunner "https://github.com/pooriaarab/foxrunner"
  click foxden "https://github.com/pooriaarab/foxden"
  click foxsync "https://github.com/pooriaarab/foxsync"
  click foxlens "https://github.com/pooriaarab/foxlens"
  click foxlink "https://github.com/pooriaarab/foxlink"
  click foxpay "https://github.com/pooriaarab/foxpay"
  click foxbridge "https://github.com/pooriaarab/foxbridge"
  click foxpass "https://github.com/pooriaarab/foxpass"
  click foxnotify "https://github.com/pooriaarab/foxnotify"
  click foxvoice "https://github.com/pooriaarab/foxvoice"
  click foxmate "https://github.com/pooriaarab/foxmate"
```

foxmate uses every primitive. Nothing depends
on foxmate. Two primitives have other names on npm: foxden is
[`foxden-sandbox`](https://www.npmjs.com/package/foxden-sandbox) and foxlink
is [`foxlink-oauth`](https://www.npmjs.com/package/foxlink-oauth).
`package.json` installs them under the names `foxden` and `foxlink`.
foxpay is [`foxpay-agent`](https://www.npmjs.com/package/foxpay-agent) on npm.
foxbridge is a dev dependency: foxmate speaks its protocol, and the E2E test
runs its host and MCP server.

## Development

```bash
pnpm install
pnpm ci:local    # lint, typecheck, tests, build, extension build, web-ext lint
pnpm e2e         # foxmate in real Firefox; writes artifacts/e2e-<date>.json
pnpm bench       # foxmate bench with the scripted planner
```

Load `dist-ext/manifest.json` from `about:debugging` to use a build in your
own Firefox.

## License

[MIT](https://opensource.org/license/mit)
