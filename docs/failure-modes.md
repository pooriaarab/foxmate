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
| S5 | A hidden element holds a link or button, so foxpaw lists it as a control | foxmate drops each control whose label is part of hidden text that foxshield found. | `tests/shield.test.ts` S5 |
| S6 | Findings are lost, so the trail cannot show what foxshield did | `onScan` gets the URL, the count, the top findings and the dropped controls. The agent writes them to the trail. | `tests/shield.test.ts` S6; E2E trap |
| S7 | The wrapper changes act, settle or runTask | They are foxpaw's own functions. | `tests/shield.test.ts` S7 |

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
