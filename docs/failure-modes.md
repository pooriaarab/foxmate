# Failure modes

foxmate composes the fox primitives. Each primitive has its own failure
modes and tests. Bugs in foxmate hide in the wiring between them: an
approval that shows one action and runs another, a private run that reaches
a cloud model, page text that reaches the planner without foxshield, a lent
tab that loses its guard, or a memory that injects text from a web page.

We write each failure mode here first. Then we write its test, then the code.
An E2E check in real Firefox is the first choice. A test in `tests/` covers a
failure that an E2E check cannot reach, or reaches only slowly.

## Brain: which model plans (`src/brain.ts`)

The brain turns the user's settings into a foxmind `Mind`. Private mode must
never reach a cloud model. The own-key mode must not send page text before
the user and Firefox both agree. The key must not pass through the brain.

| # | Failure mode | Wanted behaviour | Test |
|---|---|---|---|
| B1 | Private mode with a cloud planner picked (for example an old setting) | Refuse with `cloud-in-private`. No network call. | `tests/brain.test.ts` B1 |
| B2 | Private mode with an Ollama model whose name ends in `-cloud` or `:cloud` (it runs on Ollama's servers) | foxmind counts it as cloud, and `only: ["browser", "local"]` leaves no provider. foxmate refuses with `cloud-model-in-private`. No network call. | `tests/brain.test.ts` B2; E2E |
| B3 | Private mode with a local server address that is not on this computer, for example `http://192.168.1.5:8080/v1` | Refuse with `cloud-model-in-private`. No network call. | `tests/brain.test.ts` B3 |
| B4 | Own key without the consent box | Refuse with `no-consent` before any model call. | `tests/brain.test.ts` B4; E2E |
| B5 | Own key with the box ticked, but Firefox's `websiteContent` data consent not granted | Refuse with `no-consent`. | `tests/brain.test.ts` B5; E2E |
| B6 | The real key reaches the planner code, the trail or the sidebar | The provider gets only the foxvault handle `vault:model-key`. foxvault puts the real key in the header on the way out. | `tests/brain.test.ts` B6 |
| B7 | No planner picked | The default is Saluki 27B on llama-server, in private mode. | `tests/brain.test.ts` B7 |
| B8 | A planner name foxmate does not know | Refuse with `unknown-planner`. | `tests/brain.test.ts` B8 |
| B9 | The scripted planner gets a script that is not a JSON array | Refuse with `bad-script`. | `tests/brain.test.ts` B9 |
| B10 | The scripted planner copies a link from a page that foxshield removed | `{{lastUrl}}` reads only the newest tool result, so a removed link gives an empty value and no call to it. | `tests/brain.test.ts` B10 |
| B11 | The scripted planner cannot use a recalled note on its own, so a memory test proves nothing about the plan | `{{notes}}` gives the notes that foxmate added to the goal, joined with commas, and an empty value when there are none. | `tests/brain.test.ts` B11; E2E memory |

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

## Agent: one goal, all the parts (`src/agent.ts`)

| # | Failure mode | Wanted behaviour | Test |
|---|---|---|---|
| G1 | The approval shows one action and another one runs | The text shown is foxgate's canonical JSON of the request. The tool runs only the action that foxgate redeemed. | `tests/agent.test.ts` G1; E2E |
| G2 | Grants outlive the run (done, blocked, refused or thrown) | Every grant of the run is revoked when the run ends. Each grant also expires with the run's time budget, so an unloaded page cannot leave one. | `tests/agent.test.ts` G2 |
| G3 | The planner reaches another host | Grants cover the tab's host only. Another host gets `no-grant`. | `tests/agent.test.ts` G3; E2E trap |
| G4 | A lent tab gets more than the lent scope | The run's grants stop at the loan's scope. A `read` loan gets no `fill` or `submit` grant. | `tests/agent.test.ts` G4 |
| G5 | A run starts on a loan, but the tab is not in the loan's container | The run is refused before any model call. | `tests/agent.test.ts` G5 |
| G6 | The brain refuses (private mode, consent) | The run ends with `refused` and a reason. No tool runs. The trail records it. | `tests/agent.test.ts` G6 |
| G7 | Notes do not reach the planner, or a recall error stops the run | The planner's goal holds the notes. A recall error is an event, and the run goes on. | `tests/agent.test.ts` G7 |
| G8 | foxshield's findings are not in the trail | Each scan is a `shield.scan` trail entry. | E2E trap |
| G9 | Two runs at once share the target tab | A second run is refused with `busy`. | `tests/agent.test.ts` G9 |
| G10 | The run ends with a step that has no check (`act`, `click`) and can never pass | When the newest result has no check, foxmate reads the page and passes only when foxpaw finds no error page. The check line says so. | `tests/agent.test.ts` G10 |
| G11 | An approval to click a button that sends a form does not show what the form holds, so a human approves "click Send" with an attacker's address in the To field | The approval detail lists the other fields of that form and their values from the newest snapshot. Passwords show as `•••`. | `tests/form.test.ts` G11; E2E mail-trap |
