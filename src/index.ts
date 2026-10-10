// The foxmate agent core. The extension bundles these modules; other apps
// can use them too.
export { BrainError, KEY_HANDLE, PLANNERS, createBrain, providerHost, type Brain, type BrainDeps, type BrainErrorCode, type BrainSettings, type PlannerId, type Privacy } from "./brain.js";
export { ScriptError, parseScript, scriptMind, type ScriptStepJson } from "./scripted.js";
export { recallNotes, withNotes, type Recalled, type RecallOptions } from "./recall.js";
export { shieldedPaw, type ShieldOptions, type ShieldScan } from "./shield.js";
export { createAgent, type Agent, type AgentBrowser, type AgentEvent, type AgentOptions, type Loan, type RunEnd, type RunInput, type Trail } from "./agent.js";
export { createApprovals, type Answer, type Approvals, type ApprovalsOptions, type Waiting } from "./approvals.js";
export type { PlannerInfo } from "./planners.js";
export { formDetail } from "./form.js";
export { SPACE_DOMAIN, spaceTool, type DenLike } from "./space.js";
export { GOOGLE_DOMAIN, googleTools, lookTool, type GoogleDeps, type LookDeps } from "./modules.js";
export { shieldedMailText, shieldedText, type HtmlSanitizer, type MailPart } from "./mail.js";
export { fromAtomic, parsePayees, payTool, toAtomic, type PayOptions, type PayRun } from "./pay.js";
