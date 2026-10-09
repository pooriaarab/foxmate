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
