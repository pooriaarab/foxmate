# Failure modes

foxmate composes the fox primitives. Each primitive has its own failure
modes and tests. Bugs in foxmate hide in the wiring between them: an
approval that shows one action and runs another, a run that reaches a
cloud model, page text that reaches the planner without foxshield, a lent
tab that loses its guard, or a memory that injects text from a web page.

We write each failure mode here first. Then we write its test, then the code.
An E2E check in real Firefox is the first choice. A test in `tests/` covers a
failure that an E2E check cannot reach, or reaches only slowly.

## Brain: which model plans (`src/brain.ts`)

The brain turns the user's settings into a foxmind `Mind`. foxmate uses only
models on this computer or in Firefox. It has no cloud planner, so a run must
never reach a cloud model.

| # | Failure mode | Wanted behaviour | Test |
|---|---|---|---|
| B1 | The settings still name a cloud planner that foxmate removed (`openai`, `anthropic`) | Refuse with `unknown-planner`. No network call, and no fallback to another planner. | `tests/brain.test.ts` B1; E2E local |
| B2 | An Ollama model whose name ends in `-cloud` or `:cloud` (it runs on Ollama's servers) | foxmind counts it as cloud, and `only: ["browser", "local"]` leaves no provider. foxmate refuses with `not-local`. No network call. | `tests/brain.test.ts` B2; E2E local |
| B3 | A model server address that is not on this computer, for example `http://192.168.1.5:8080/v1` | Refuse with `not-local`. No network call. | `tests/brain.test.ts` B3 |
| B7 | No planner picked | The default is Saluki 27B on llama-server. | `tests/brain.test.ts` B7 |
| B8 | A planner name foxmate does not know | Refuse with `unknown-planner`. | `tests/brain.test.ts` B8 |
| B9 | The scripted planner gets a script that is not a JSON array | Refuse with `bad-script`. | `tests/brain.test.ts` B9 |
| B10 | The scripted planner copies a link from a page that foxshield removed | `{{lastUrl}}` reads only the newest tool result, so a removed link gives an empty value and no call to it. | `tests/brain.test.ts` B10 |
| B11 | The scripted planner cannot use a recalled note on its own, so a memory test proves nothing about the plan | `{{notes}}` gives the notes that foxmate added to the goal, joined with commas, and an empty value when there are none. | `tests/brain.test.ts` B11; E2E memory |
| B12 | A gullible scripted step (it obeys an injection) runs even when foxshield removed the injection, so the bench cannot show what the shield does | A step with `ifText` runs only when the newest tool result holds that text, and one with `ifSeen` only when an earlier result did. | `tests/brain.test.ts` B12; foxbench |

## Shield: page text before the planner (`src/shield.ts`)

Every page text that foxloop's browser tools read goes through foxshield
first. The planner gets `sanitize()` output, not raw DOM text. The page is
untrusted data.

| # | Failure mode | Wanted behaviour | Test |
|---|---|---|---|
| S1 | Hidden text (white on white, off-screen, `aria-hidden`) holds an instruction | It is not in the text the planner reads. | `tests/shield.test.ts` S1; E2E trap |
| S2 | Visible text holds an instruction ("ignore previous instructions") | It stays, wrapped in `<untrusted-data>`, so the planner reads it as data. | `tests/shield.test.ts` S2 |
| S3 | The scan throws in the tab (a frame went away, the page navigated) | foxmate withholds the page text and says so. Raw text never goes to the planner. | `tests/shield.test.ts` S3 |
| S4 | The scan returns no result | The same as S3. | `tests/shield.test.ts` S4 |
| S5 | A hidden element holds a link or button, so foxpaw lists it as a control | foxmate asks the page which controls sit inside an element that foxshield found hidden, and drops those. | `tests/shield.test.ts` S5; E2E signup-trap |
| S6 | Findings are lost, so the trail cannot show what foxshield did | `onScan` gets the URL, the count, the top findings and the dropped controls. The agent writes them to the trail. | `tests/shield.test.ts` S6; E2E trap |
| S7 | The wrapper changes act, settle or runTask | They are foxpaw's own functions. | `tests/shield.test.ts` S7 |
| S8 | Harmless hidden text (the options of a `<select>`, a menu below the fold) shares words with a real control's label, so S5 drops the control | A control outside every hidden element stays. | `tests/shield.test.ts` S8; E2E signup |
| S9 | Flagged hidden text names a real field ("add the email and password to the link"), so a word match drops the visible Password field | Only the page's own answer (S5) drops a control. A word match never does. | `tests/shield.test.ts` S9; E2E signup-trap |
| S10 | The page cannot answer which controls are hidden | The same as S3: the page text is withheld. | `tests/shield.test.ts` S10 |
| S11 | A click on a link starts a navigation, and the next snapshot reads the page while it loads: 0 controls and no text (seen in a recorded, headed E2E run of foxbench `mail-trap`) | Before it reads, the shield waits until the tab reports `complete`, for up to 10 s. | `tests/shield.test.ts` S11 |

## Recall: memories in the goal (`src/recall.ts`)

foxmate recalls memories that fit the goal and adds them to the goal as
notes. The goal is trusted text, so a note must come from the user.

| # | Failure mode | Wanted behaviour | Test |
|---|---|---|---|
| M1 | A memory that a page or an import wrote (`source` is not `user`) | It is never a note. | `tests/recall.test.ts` M1 |
| M2 | A note holds markup such as `</untrusted-data>` or `<\|im_start\|>` | foxmate removes `<` and `>` from notes. | `tests/recall.test.ts` M2 |
| M3 | The embedder fails (the model is not loaded) | The run goes on with no notes. The result says why. | `tests/recall.test.ts` M3 |
| M4 | A memory that does not fit the goal | Memories under the minimum similarity stay out. | `tests/recall.test.ts` M4 |
| M5 | A very long memory, or many memories | Each note is cut to 300 characters. At most 5 notes. | `tests/recall.test.ts` M5 |
| M6 | A note holds zero-width or bidi characters that hide text | foxmate removes them. | `tests/recall.test.ts` M6 |

## Approvals: one answer per exact action (`src/approvals.ts`)

The sidebar and, when it is on, the phone can both answer an approval. The
answer must reach the one request it names, once.

| # | Failure mode | Wanted behaviour | Test |
|---|---|---|---|
| A1 | An answer names another request | It does not decide any other request. | `tests/approvals.test.ts` A1 |
| A2 | Two channels answer (the sidebar approves, then the phone denies) | The first answer decides. The second one is ignored and reported as late. | `tests/approvals.test.ts` A2 |
| A3 | An answer comes before foxloop asks (a fast click) | It is kept for that request only, if foxgate holds the request. | `tests/approvals.test.ts` A3 |
| A4 | Nobody answers | The request ends as no at its foxgate expiry. The run does not hang. | `tests/approvals.test.ts` A4 |
| A5 | The run ends while a request waits | Every waiting request ends as no. | `tests/approvals.test.ts` A5 |
| A6 | An answer is lost, so the trail cannot show who approved | Each deciding answer goes to the trail with the request id, the decision and the channel. | `tests/approvals.test.ts` A6 |
| A7 | An answer comes after its run ended (the phone prompt stayed open), and foxgate reuses the still-pending request for the same action in the next run, so the old answer approves it | Only requests that the current run announced can be answered. When a run ends, foxmate rejects its open requests in foxgate. | `tests/approvals.test.ts` A7 |

## Agent: one goal, all the parts (`src/agent.ts`)

| # | Failure mode | Wanted behaviour | Test |
|---|---|---|---|
| G1 | The approval shows one action and another one runs | The text shown is foxgate's canonical JSON of the request. The tool runs only the action that foxgate redeemed. | `tests/agent.test.ts` G1; E2E |
| G2 | Grants outlive the run (done, blocked, refused or thrown) | Every grant of the run is revoked when the run ends. Each grant also expires with the run's time budget, so an unloaded page cannot leave one. | `tests/agent.test.ts` G2 |
| G3 | The planner reaches another host | Grants cover the tab's host only. Another host gets `no-grant`. | `tests/agent.test.ts` G3; E2E trap |
| G4 | A lent tab gets more than the lent scope | The run's grants stop at the loan's scope. A `read` loan gets no `fill` or `submit` grant. | `tests/agent.test.ts` G4 |
| G5 | A run starts on a loan, but the tab is not in the loan's container | The run is refused before any model call. | `tests/agent.test.ts` G5 |
| G6 | The brain refuses (a model that is not on this computer) | The run ends with `refused` and a reason. No tool runs. The trail records it. | `tests/agent.test.ts` G6 |
| G7 | Notes do not reach the planner, or a recall error stops the run | The planner's goal holds the notes. A recall error is an event, and the run goes on. | `tests/agent.test.ts` G7 |
| G8 | foxshield's findings are not in the trail | Each scan is a `shield.scan` trail entry. | E2E trap |
| G9 | Two runs at once share the target tab | A second run is refused with `busy`. | `tests/agent.test.ts` G9 |
| G10 | The run ends with a step that has no check (`act`, `click`) and can never pass | When the newest result has no check, foxmate reads the page and passes only when foxpaw finds no error page. The check line says so. | `tests/agent.test.ts` G10 |
| G11 | An approval to click a button that sends a form does not show what the form holds, so a human approves "click Send" with an attacker's address in the To field | The approval detail lists the other fields of that form and their values from the newest snapshot. Passwords show as `•••`. | `tests/form.test.ts` G11; E2E mail-trap |
| G12 | A goal from Chat runs on a lent tab without naming the loan, so it gets fill and submit grants inside the logged-in container | When the tab is in a loan's container, the run is a loan run with that loan's scope, named or not. | `tests/agent.test.ts` G12 |
| G13 | foxlend's grant for a loan (its site and its allow list) sits on the agent's gate, so every run can reach those hosts | foxlend gets a gate host of its own. The agent's runs get only their own grants. | E2E lend |
| G14 | The extra tools (the Space, Google) get grants above a loan's scope | On a loan run, an extra tool gets a grant only when its scope is within the loan's scope. | `tests/agent.test.ts` G14 |
| G15 | A small model says "done" before it calls any tool, and the page check passes because the page shows no error (seen with Qwen3 on foxbench) | With no task check, `finish` passes only when a tool ran with a good result in this run, and the page shows no error. |  `tests/agent.test.ts` G15 |
| G16 | The planner reads private data (mail, events, Space files), then a page tells it to put that data in an `open_url` query on the tab's host, or to type it into a field that page script can read. Both are on the run's grants (read and fill), and foxgate asks only for submit and pay, so the data leaves with no approval | Once a run has read private data, every `open_url` and every fill tool (`act`) needs an approval for the rest of the run. Page reads (`snapshot`) do not. | `tests/agent.test.ts` G16 |
| G17 | The goal carries memory notes, which are private, and the same leak happens from the first step | A run whose goal has notes starts in the same mode as G16. | `tests/agent.test.ts` G17 |
| G18 | A goal can read the user's mail and calendar although the user asked for nothing of the kind, for example a goal planted by a page or a schedule | The planner gets the Google tools, but the first `read_inbox` and the first `read_calendar` of a run each wait for an approval ("Read your mail for this goal?"). A schedule that the user set to read mail (`allowPrivate`) asks nothing. An outside agent (foxbridge) gets no Google grant. | `tests/agent.test.ts` G18; E2E modules O2 |
| G19 | A tab sits in a loan's container while the loan is still being created or revoked, and the run gets the normal grants | foxmate matches a loan in any state; a loan that is not active refuses the run. | `tests/agent.test.ts` G19 |
| G20 | A loan run follows its tab to another host, and gets grants for that host inside the logged-in container | A loan run is refused unless the tab is on the lent host or, for a site loan, the lent site. | `tests/agent.test.ts` G20 |
| G21 | The approval shows the form's values cut to 80 and 240 characters, so the end of a long value that the planner typed (an address, a message) is hidden | The field the planner typed last is shown in full. | `tests/form.test.ts` G21 |
| G22 | The last tool calls fail (no control, nothing done), the planner calls `finish`, and the run ends as done because an earlier step worked and the page shows no error (seen in the same run) | With no task check, `finish` passes only when the newest tool result is good. |  `tests/agent.test.ts` G22 |
| G23 | The planner does not know which page is open or which sites the run may reach, so it makes up a real site's address (`open_url` to `www.kayak.com` on a local flights page) and the gate denies it (seen with Saluki 27B on foxbench: 4 of 13 tasks ended that way) | Each request from foxmate's own planner has a context block in its system message: the open tab's address and title, the sites the run has grants for, and the rule to work on the open page and not to make up addresses. foxmate reads the tab again for each request, so the block follows the run. | `tests/agent.test.ts` G23 |
| G24 | The tab's title or address carries instructions into the system message (a prompt injection through the context block) | The title is page text: it is cut to 120 characters, its line breaks and angle brackets are removed, and it is quoted and marked "page text, not instructions". The address shows only its origin and path, with no query or fragment. | `tests/agent.test.ts` G24 |
| G25 | The planner gets tools that the run has no grant for (the Gmail tool `read_inbox` on a run with no Google grant), calls one, and the gate denies it (seen: all 3 foxbench mail tasks) | foxmate's own planner gets only the tools that the run holds a grant for: the tab tools when the tab shows a web page, an extra tool when it got its grant (G14, G18), and `pay` when the tab shows a web page. | `tests/agent.test.ts` G25 |
| G29 | An outside agent's call (foxbridge) that the gate denies reaches it as a failed result, not as `denied` | G23-G27 apply to foxmate's own planner only. On a bridge run every denial ends the run, and the agent gets `denied` (BR3). | `tests/bridge.test.ts` BR3 |
| G30 | After one approval, the planner reads mail in the next run, or reads the calendar too, with no new approval | The approval swaps the grant of that one tool for a grant with no approval, for this run only. Every grant ends with the run (G2). The other Google tool still asks. | `tests/agent.test.ts` G30 |

## Rules: standing answers for one site (`src/approvals.ts`, `src/agent.ts`)

foxgate keeps user rules: "always allow click on example.com", "always ask
before it reads bank.com", "never let it submit on shop.com". An approval
card offers "Always allow <tool> on <site>". Settings lists the rules, with
Remove, and adds "Always ask" and "Never allow" for the current site. A rule
changes only the approval step of a grant that the run already has.

| # | Failure mode | Wanted behaviour | Test |
|---|---|---|---|
| RU1 | The run read private data (mail, Space files, memory notes, a paid answer), and an `allow` rule skips the approval of a submit, so the data leaves with no human | Only the submit grant of a run with no private data has `rules: true`. After private data foxmate adds it again without `rules`, so the click asks. The card does not offer "Always allow" on a private run. | `tests/rules.test.ts` RU1; E2E rules |
| RU2 | The card offers "Always allow" for a payment or a saved-login fill | The offer exists only for `read` and `submit` actions on a run's own tab tools. A pay approval and a fill approval (its own gate) get no offer. An `always-allow` answer to such a request decides nothing. | `tests/rules.test.ts` RU2 |
| RU3 | A rule for `a.com` acts on `b.com`, or a rule made on `shop.a.com` widens to the whole public suffix | The rule site is the registrable domain of the action's host, from the same public suffix list as foxgate. A host with no registrable domain (an IP address, `localhost`) gets no offer. foxgate matches by whole labels (foxgate U1). | `tests/rules.test.ts` RU3; E2E rules |
| RU4 | A rule outlives the run's grants and allows an action with no grant: the next run on another tab, or after a revoke | A rule never makes a grant. The run's grants end with the run (G2), and the next action with no grant gets `no-grant`. The rule itself stays across runs and restarts, in `browser.storage.local`. | `tests/rules.test.ts` RU4 |
| RU5 | The user removes a rule, and the next action still skips the approval | Remove calls foxgate's `removeRule`. The next check reads the rules again, so the click asks. | E2E rules |
| RU6 | The trail cannot show that a rule decided, or which one | foxgate's `onDecision` writes `gate.rule` with the `ruleId` for each decision that a rule made ("allowed by rule <id>", "denied by rule <id>"). "Always allow" writes `rule.add` with the rule before it approves. A failed write gives `deny` `hook-failed`, and no rule is added. | `tests/rules.test.ts` RU6; E2E rules |
| RU7 | The phone (or any channel but the sidebar) adds a standing rule | An `always-allow` answer counts from the sidebar only. The phone never shows the choice. | `tests/rules.test.ts` RU7 |
| RU8 | A lent login gets a standing `allow` | A loan run adds no grant with `rules: true` and the card makes no offer. | `tests/rules.test.ts` RU8 |
| RU9 | A page message adds an `allow` rule with no approval card | `rules:add` takes `ask` and `deny` only, for the registrable site of the tab it names. The only way to add `allow` is the card's answer to a waiting request. | E2E rules |
| RU10 | `addRule` throws (`bad-rule`, a storage error), and the request is approved anyway or hangs | foxmate records nothing, approves nothing, and the request still waits for Approve or Deny. | `tests/rules.test.ts` RU10 |

## No tab: the agent opens a site (`src/agent.ts`)

A goal can start with no web page open ("Book a table at Bistro Lune
tonight"). The run starts with no host. Its planner gets one tool for the
web, `open_site`. Each call waits for an approval ("Open bistrolune.com?").
On Approve, foxmate opens the address in a new tab, gives the run the
grants for that tab's host (the same as a tab the user picked), and goes on
there. A search page is a site like any other, so it asks too.

| # | Failure mode | Wanted behaviour | Test |
|---|---|---|---|
| OS1 | The agent opens a site with no approval: a rule, a grant with no approval, or the phone's "Always allow" | The `open_site` grant has `approval: "always"` and no `rules`, for the domain `new-tab.foxmate` only. The card never offers "Always allow" for it. | `tests/agent.test.ts` OS1; E2E open |
| OS2 | A run on a web tab gets `open_site`, so it browses to other hosts around G3 | Only a run that starts with no web page, with foxmate's own planner and no loan, gets `open_site`. | `tests/agent.test.ts` OS2 |
| OS3 | The grant leaks to other hosts: the approved site's grants cover the next site, or the first site keeps its grants after a second `open_site` | The run gets grants for the opened tab's host only. A second `open_site` revokes the first host's grants before it adds the new ones. Another host gets `no-grant` (G3). | `tests/agent.test.ts` OS3; E2E open |
| OS4 | The approved address redirects to another site, and the run works there | foxmate compares the registrable site of the loaded page with the approved one. Another site gets no grant: the tool fails, says where the page went, and the trail records `run.open-site` with `granted: false`. A redirect inside the same site (`www.`) grants the loaded host only. | `tests/agent.test.ts` OS4; E2E open |
| OS5 | The address is not a web address (`javascript:`, `file:`, `data:`) or carries a login (`https://user:pass@host/`) | The tool's schema refuses it before any approval (`invalid-args`), and the tool checks again before it opens a tab. | `tests/agent.test.ts` OS5 |
| OS6 | With no tab, the planner makes up tools or calls a page tool before a page is open | The planner gets only `open_site` and the extra tools until a tab opens. A call to a page tool runs nothing. The context block says that no page is open and that `open_site` asks the user. | `tests/agent.test.ts` OS6 |
| OS7 | The approval hides the full address, so a query that carries private data looks harmless | The card names the host. "Details" holds foxgate's canonical JSON with the full address. Each `open_site` asks, also after private data (G16). | `tests/agent.test.ts` OS1 |
| OS8 | The page does not load, or the user closes the tab or presses Stop while it loads | The tool waits for up to 20 s and stops at Stop. A page that does not load gets no grant, and the tool fails. | `tests/agent.test.ts` OS8 |

## Space: Python on a dropped file (`src/space.ts`)

The planner can run Python on files the user drops into the Space. foxden
runs it in a sandbox page with no network and no extension APIs.

| # | Failure mode | Wanted behaviour | Test |
|---|---|---|---|
| D1 | The Python that the planner writes reaches the network | foxden's sandbox page has `connect-src 'none'`. The call fails. | E2E space |
| D2 | Python output goes to the planner as trusted text (the file can hold an injection) | The output goes in `untrusted`, as data. | E2E space |
| D3 | A Python error passes the check, so the run says done | `run_python` returns a check that passes only when Python raised no error. | E2E space |
| D4 | The Space tool works outside its sandbox domain, or a page host grant covers it | It has its own grant, for the domain `space.foxmate` and the tool `run_python` only. | E2E space |
| D5 | A goal about a file needs a web page in the tab | A run on a tab with no web page gets no tab grants, but the Space tool still works. | E2E space |

## The app page (`extension/app.html`, `target.js`)

The app runs in a tab (the toolbar button opens it) and in the sidebar. In a
tab, the active tab is the app itself.

| # | Failure mode | Wanted behaviour | Test |
|---|---|---|---|
| UI2 | A goal from the full page runs on the foxmate page itself, the active tab | The target is the tab the user picked, else the active web tab of the window, else the web tab used last. Only http and https tabs count. The composer chip names it. | E2E app UI2 |
| UI3 | Each toolbar click opens one more app tab, each with its own port and phone link | The toolbar button brings the open app tab to the front, and opens a tab only when none is open. | E2E app UI3 |

## Sidebar link: the background page lifecycle

| # | Failure mode | Wanted behaviour | Test |
|---|---|---|---|
| K1 | Firefox unloads the idle background page while an approval waits (seen in Firefox 157 about 60 s after the last event, with the sidebar and its port open) | While a sidebar is open, it sends the background page a message every 20 s, so the page stays loaded. | E2E keepalive |
| K2 | The background page restarts (an update, a crash, an unload with no sidebar), and the open sidebar keeps a dead port | The sidebar connects again, and gets the current run and the waiting approvals. | E2E keepalive |
| K3 | Two goals start at once (a double click, or foxrunner waking two tasks), so the second one takes over the run that Stop aborts and the sidebar shows | The background page claims the run before its first await. The second goal ends as refused (`busy`), see Q2. | E2E keepalive |
| Q1 | A goal runs again (after an unload, or a retry) on whatever the tab shows now, with no human watching, for example a page that the tab moved to in the meantime | Each task keeps the host where it started. A run whose tab is now on another host is refused, and the trail records it. | E2E tasks Q1 |
| Q2 | A goal that meets another run retries every 30, 60 and 120 s and starts later, when nobody expects it | A goal that meets another run ends at once as refused (`busy`). The user starts it again. | E2E keepalive K3 |

## Mail and events: outside text from Google (`src/mail.ts`)

| # | Failure mode | Wanted behaviour | Test |
|---|---|---|---|
| MS1 | A multipart mail shows the user a harmless HTML part, and hides instructions in the text/plain part (or the reverse), and foxlink reads the plain part first | foxmate prefers the HTML part, passes it through foxshield (hidden text removed), and says which part it used. | `tests/mail.test.ts` MS1 |
| MS2 | A plain-text mail holds an instruction | The text passes foxshield too; an instruction arrives in `<untrusted-data>`. | `tests/mail.test.ts` MS2 |
| MS3 | The body is base64url with non-ASCII text, and a naive decode garbles it | foxmate decodes base64url as UTF-8. | `tests/mail.test.ts` MS3 |
| MS4 | A mail has no text part | The text is empty, and the part is `none`. | `tests/mail.test.ts` MS4 |
| MS5 | A calendar event's description holds an instruction | It passes foxshield like a mail body. | `tests/mail.test.ts` MS5 |

## Pay: one approval for each payment (`src/pay.ts`)

The planner can ask to pay a bill on the tab's host with foxpay's x402
method. foxpay reads the real amount from the `402` answer, foxgate checks
the cap, and a human approves each payment.

| # | Failure mode | Wanted behaviour | Test |
|---|---|---|---|
| PY1 | The user set no cap (the default), or a cap of 0 | The pay tool refuses and says so. foxpay does not fetch the address. | `tests/pay.test.ts` PY1; E2E pay |
| PY2 | The amount is over the cap | foxgate refuses with `spend-cap` before any approval. Nothing is paid. | `tests/pay.test.ts` PY2; E2E pay |
| PY3 | The approval hides the amount, the currency, the payee or the host | The approval text is foxgate's canonical JSON of foxpay's pay action. The detail names the amount, the currency, the payee and the host. | `tests/pay.test.ts` PY3; E2E pay |
| PY4 | The planner names an amount that the bill does not ask for, or the bill changes its price after the approval | foxpay refuses (`amount-mismatch`, or `amount-changed` before it uses the token). Nothing is paid or spent. A new amount is a new action with its own approval. | `tests/pay.test.ts` PY4 |
| PY5 | The same payment runs again: the planner asks twice, or foxrunner runs the task again | The idempotency key comes from the task, the address and the amount. foxpay gives back the first receipt, pays nothing, and asks nothing. | `tests/pay.test.ts` PY5; E2E pay |
| PY6 | One approval pays two times | foxpay uses the foxgate token one time. The paid API sees one payment. | `tests/pay.test.ts` PY5; E2E pay |
| PY7 | A loan run pays with the lent login | A loan run gets no pay grant: pay is above every loan scope. | `tests/pay.test.ts` PY7 |
| PY8 | The payment goes to a host that is not the tab's host | The grants cover the tab's host only (`no-grant`). | `tests/pay.test.ts` PY8 |
| PY9 | A payment is not in the trail | foxpay's events (`pay.request`, `pay.ask`, `pay.result` with the receipt) go to foxtrail. When the trail write fails before the payment, foxpay stops (`hook-failed`). | E2E pay |
| PY10 | The paid answer reaches the planner as trusted text, and a page then makes the planner carry it out | The answer goes to the planner as data, and the run holds private data from then on (G16). | `tests/pay.test.ts` PY10 |
| PY11 | The human denies, or the run stops while the approval waits | Nothing is paid. foxmate rejects the request in foxgate. | `tests/pay.test.ts` PY11 |
| PY12 | The wallet key reaches the planner, the trail or `storage.local` in clear | foxvault keeps it encrypted. Only foxpay's signer gets it, through `vault.use`. The receipt holds the payer address and the nonce. | E2E pay |


## Bridge: an outside agent on one shared tab (`src/bridge.ts`, `extension/bridge.js`)

An MCP client such as Claude Code drives one tab that the user shares from
the sidebar. foxmate speaks foxbridge's native messaging protocol. Each
call is a run of its own through the agent, with a planner that asks for
that one call.

| # | Failure mode | Wanted behaviour | Test |
|---|---|---|---|
| BR1 | A call names a tab that the user did not share | foxmate refuses it with `not-shared` before any run. | E2E bridge |
| BR2 | A bridge call skips foxgate, foxshield or the approvals that foxmate's own planner gets | The call runs through `agent.run`: grants for the tab's host only, foxshield on each page read, and the approval in Chat. | `tests/bridge.test.ts` BR2; E2E bridge |
| BR3 | A call reaches another host, for example `open_url` to another site | foxgate denies it (`no-grant`). The agent gets `denied`. | `tests/bridge.test.ts` BR3 |
| BR4 | The agent gets raw page text, with the hidden text in it | The reply holds the text that a planner reads: foxshield's output, between foxloop's data marks. | `tests/bridge.test.ts` BR4; E2E bridge |
| BR5 | Memory notes join a bridge call's goal, so they reach the outside agent or change the grants | A run with an outside planner recalls no memories. | `tests/bridge.test.ts` BR5 |
| BR6 | A denied approval reaches the agent as a good result | The agent gets `approval-denied`, and nothing ran. | `tests/bridge.test.ts` BR6; E2E bridge |
| BR7 | The shared tab moves to another host, and the agent drives the new site | foxmate stops sharing, and refuses the call with `not-shared`. | E2E bridge |
| BR8 | Stop leaves the agent connected, or an approval waiting | Stop closes the native port, ends the waiting run (its approval ends as no) and stops sharing. The agent gets `host-gone`, then `bridge-off`. | E2E bridge |
| BR9 | A tab is shared, so its page text goes to an outside program, without Firefox's consent for page content | The share click asks Firefox for `websiteContent` data consent and the `nativeMessaging` permission. A refusal, or an error, keeps the bridge off. The background page checks both again before it starts the host. | E2E bridge |
| BR10 | The bridge adds a required permission, so every existing install sees a prompt on update | `nativeMessaging` is an optional permission, asked for at the share click. `websiteContent` is optional data collection. | E2E bridge (reads `dist-ext/manifest.json`) |
| BR11 | A hook that grants the consent for tests ships in `dist-ext/` | The E2E test grants it with a real click in a test profile whose pref skips the prompt. `dist-ext/` has no grant hook. | E2E bridge |

## Sign-in handoff: the user signs in, not the agent (`src/pass.ts`)

A run can reach a sign-in page, a one-time code, a passkey request, a
CAPTCHA or an OAuth consent screen. Only the user can do that step.
foxpass names the step, and the run waits for the user.

| # | Failure mode | Wanted behaviour | Test |
|---|---|---|---|
| HP1 | A run reaches a sign-in wall and fails, or the planner tries to type into the password field | Before each page read, foxpass scans the tab. On a wall, the run waits. The planner reads the page only after the user signs in. | E2E pass |
| HP2 | The user does not know that the agent waits for them | Chat shows "Sign in on this tab, then the agent goes on.", with foxpass's words for the step. foxpass brings the tab to the front and outlines the field. | E2E pass |
| HP3 | The run waits after the user signed in | foxpass's signed-in signal ends the wait, and the read goes on with the new page. A password page that leads to a code page stays one wait. | E2E pass |
| HP4 | The user does not sign in, or presses Stop, and the run hangs | Stop ends the wait and the run. A timeout or a closed tab fails the read, and the planner is told to stop. | E2E pass (Stop) |
| HP5 | A typed password or code reaches the planner, as a field value or as page text that repeats it | Each snapshot passes foxpass's `redactSnapshot` after foxshield. A secret field and each copy of its value show `[redacted]`. Fields get foxpass's `autocomplete` hint from the newest scan of the tab. | `tests/pass.test.ts` HP5; E2E pass (leak check) |
| HP6 | A typed secret reaches the log, the sidebar or memory | foxshield's quotes in the log pass the same redaction. The handoff entries in the log hold the step kind, the host and the end status only. A run writes no memory. | E2E pass (leak check) |
| HP7 | The scan fails (a page that foxmate cannot script), and every page read stops | foxmate logs `handoff.scan-failed`, and the read goes on with no wait. foxshield still reads the page. | `tests/pass.test.ts` HP7 |
| HP8 | foxpass needs `webNavigation`, so every install sees a permission prompt on update | foxmate gives foxpass a stand-in that reads the tab address from `tabs.get`. foxpass then reads the top frame of the tab. The manifest gets no new permission. | E2E pass (reads `dist-ext/manifest.json`) |
| HP9 | A sign-up form, where the goal gives a new password, pauses the run | A password field with `autocomplete="new-password"` is not a wall for foxmate. The planner fills it, and the send still asks you. | E2E signup (E1) |

## Saved logins: fill a sign-in from foxvault (`src/logins.ts`)

The user saves a login for a site in Settings: the host, the username and the
password. A login vault (foxvault, its own store and key) keeps the password.
At a sign-in wait, Chat offers "Fill saved login". foxpass's `fillWall` fills
the password only into the field that its scan found as the sign-in step,
after the user approves. The planner never asks for a fill and never sees the
value.

| # | Failure mode | Wanted behaviour | Test |
|---|---|---|---|
| LV1 | The saved password reaches the planner: as a field value, or as page text that repeats it (an error page that echoes it) | The fill runs while the run waits, before the planner reads the page. Every message to the planner passes the login vault's `redact` first, so a copy shows the handle. | `tests/logins.test.ts` LV1; E2E vault |
| LV2 | The tab is on a look-alike host (`bank.example.evil.test`) or on another host than the saved one | Chat offers the fill only when the wall's host equals the saved host. The secret holds that one host, so foxvault refuses `domain` too. | `tests/logins.test.ts` LV2 |
| LV3 | The sign-in form is in an iframe | foxpass scans the top document only, so there is no password wall and no fill (`no-password-field`). foxvault fills the top document only. | `tests/logins.test.ts` LV3 |
| LV4 | A fill runs with no approval, or after Deny | The fill has a foxgate of its own, with `foxvault.fill` as its one tool. Its only grants are `approval: "always"`, for the wall's host, one per click, for 2 minutes. Deny fills nothing. | `tests/logins.test.ts` LV4; E2E vault |
| LV5 | The approval hides where the password goes | The approval text is foxgate's canonical JSON of the fill: the handle, the host and the selector. The detail names the host and the field. | `tests/logins.test.ts` LV5; E2E vault |
| LV6 | The value reaches the log or its export | Every log entry passes the login vault's `redact` before foxtrail writes it. foxvault's `onEvent` writes `vault.release` with the handle and the host only. | `tests/logins.test.ts` LV6; E2E vault (export) |
| LV7 | The phone approves a fill | A fill approval is a `login-approval` event, which the phone does not show. An answer that does not come from the sidebar decides nothing. | `tests/logins.test.ts` LV7 |
| LV8 | A fill click comes when no run waits at a sign-in, or after the wait ended | foxmate refuses `no-wait`. The end of the wait rejects its open fill requests and revokes the grants. | `tests/logins.test.ts` LV8 |
| LV9 | The page changes between the scan and the fill (a redirect, a reload) | The fill is pinned to the document that the scan read (`documentId`). foxvault refuses `page-changed`. | `tests/logins.test.ts` LV9 |
| LV10 | The fill writes into a plain `http:` page on the network, where others can read the password | foxvault refuses `http`. foxmate sets `allowHttp` only for a host on this computer (`127.0.0.1`, `localhost`, `*.localhost`). | `tests/logins.test.ts` LV10 |
| LV11 | The username goes into a field that the user did not approve | The username goes only into an empty email or username field of the same form as the approved password field, in the same document, after that fill worked. The approval detail names that field. | `tests/logins.test.ts` LV11; E2E vault |
| LV12 | The password stays in the Settings field, or reaches `storage.local` or the sidebar in clear | The field clears at the save. The login vault keeps ciphertext only. The list shows the host and the username, never the password. | E2E vault |
| LV13 | foxvault needs `webNavigation` for the document, so every install sees a permission prompt | foxmate gives foxvault and the fill scan a stand-in: `scripting.executeScript` on frame 0 reports the URL and the `documentId`. The manifest gets no new permission (HP8). | E2E vault (reads `dist-ext/manifest.json`) |
| LV14 | The planner asks for a fill | `foxvault.fill` is not a planner tool. Only the Chat button starts a fill. | `tests/logins.test.ts` LV14 |

## Notices: when a run needs the user (`extension/background.js`, `extension/notices.js`)

foxnotify tells the user that a run waits for them, ended, or that a
schedule ran late, while no sidebar is in view. The approval itself stays
in Chat.

| # | Failure mode | Wanted behaviour | Test |
|---|---|---|---|
| NT1 | An approval waits while the sidebar is closed, and the user never learns of it | foxnotify shows "Approval needed" with the goal. A sidebar in view gets no notice. | E2E notify |
| NT2 | A click on a notice approves the action | A click opens `app.html#approval` in a tab, or focuses the run's tab. The approval waits there for Approve or Deny. foxmate gives foxnotify no way to answer. | E2E notify |
| NT3 | A sign-in wait, a finished or stuck run, or a schedule run that starts late passes with no notice | foxpass's `onNeedsUser`, the end of a run, and a schedule run more than 60 s after its time each send a notice. A finished run is low priority, so it waits for the digest. | E2E notify (task-done in the digest) |
| NT4 | Quiet hours in Settings do not reach foxnotify | Settings saves them with `setRules`. Below `urgent`, a notice waits until quiet hours end. | E2E notify (reads `fnt:rules`) |
| NT5 | The webhook sends titles made from goals or pages without a data declaration (foxnotify DC1) | The webhook is off by default and sends no title by default. "Put the goal in the webhook notice" asks Firefox for `websiteActivity` consent, and the background page checks it again at each send. The manifest declares `websiteActivity` as optional. | E2E notify (the stand-in webhook) |
| NT6 | The preview shows another request than the webhook sends | The preview is foxnotify's `previewWebhook` with the same options. | E2E notify |
| NT7 | A notice field in Settings overwrites the other settings | The notice fields save `settings.notices` only, and the Settings view does not save on their change. | E2E notify |
| NT8 | A runner with no notification service (a Linux CI runner) fails the run | As in foxnotify (CI1): with `CI` set, a failed check of what Firefox shows logs `SKIP (CI)`. The click, webhook and rules checks still count. | E2E notify |

## Voice: push to talk in Chat (`extension/voice.js`, `extension/mic.js`)

foxvoice turns speech into the goal text while the user holds the talk
button. Whisper runs in the sidebar page.

| # | Failure mode | Wanted behaviour | Test |
|---|---|---|---|
| VO1 | A misheard goal runs at once | The transcript fills the goal box only. The user can edit it, and Run stays the user's click. | E2E voice |
| VO2 | Audio or its text leaves the computer | foxmate gives foxvoice one provider: Whisper in the sidebar page, with `only: ["browser"]`. The model host gets only requests for model files. | E2E voice |
| VO3 | The microphone stays on after the user lets go | foxvoice stops each track when the user lets go. | E2E voice |
| VO4 | The sidebar cannot get the microphone, because Firefox shows no prompt there | The error shows "Set up the microphone". It opens `mic.html` in a tab, which asks Firefox once. The permission belongs to the extension, so the sidebar gets it too. | E2E voice (Firefox's fake device) |
| VO5 | The result is spoken when the user did not ask for it | "Speak the result" is off by default. When it is on, foxvoice speaks the end line that Chat shows, with a voice on this computer. | E2E voice |
| VO6 | The test microphone or its sound file ships in `dist-ext/` | The E2E test replaces `getUserMedia` from outside the add-on. `dist-ext/` has no `.wav` file and no hook. | E2E voice (reads `dist-ext/`) |

## AMO release build and listed submission (`scripts/amo-listing.mjs`)

`pnpm check:amo` reads `dist-ext/`, which is what `release.yml` signs. Each
row is a way that the listed build or the submission can go wrong.

| ID | Failure | Wanted result |
|---|---|---|
| AR1 | `dist-ext/` is missing, so the check reads nothing | The check stops and says to run `pnpm build:ext` |
| AR2 | A content script in the release manifest matches `127.0.0.1`, `localhost` or `*.localhost` (a test bridge) | The check stops and names the pattern |
| AR3 | A host permission for a local host exists only for tests | The check stops, unless `local_hosts` in the listing gives a reason for that exact pattern |
| AR4 | A file named for tests (`e2e`, `fixture`, `test`, `spec`) is in `dist-ext/` | The check stops and names the file |
| AR5 | `dist-ext/` came from `build-ext.mjs --e2e` | AR2 or AR4 stops it |
| AR6 | The `local_hosts` reasons go to AMO as an unknown field | `metadata` leaves them out, as it does the privacy policy |
| AR7 | A re-run submits a version that AMO already has as listed | `version-status` says `listed`, and the step skips web-ext sign and finishes the release |
| AR8 | AMO has the version as unlisted | `version-status` stops and says to bump the version |
| AR9 | The AMO version lookup fails (401, 500, network) | `version-status` stops; it never guesses `absent` |
| AR10 | The add-on already exists on AMO, and the version lookup sends a parameter AMO refuses on a single version (400), so every release stops | `version-status` asks for `versions/v<version>/` with no query; an owner sees listed and unlisted versions there |

| ID | Failure | Wanted result |
|---|---|---|
| AR-U1 | A `local_hosts` reason for a host permission also clears a test content script on the same pattern | Each reason names its use (`host_permission`, `content_script`, `web_accessible_resource`, `externally_connectable`); a use without its own reason stops the check |
| AR-U2 | `local_hosts` keeps a reason for a use that the release build does not have | The check stops and names the pattern and the use |
