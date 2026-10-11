// The foxmate agent core. The extension bundles these modules; other apps
// can use them too.
export { BrainError, PLANNERS, createBrain, type Brain, type BrainDeps, type BrainErrorCode, type BrainSettings, type PlannerId } from "./brain.js";
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
export { BridgeRefusal, bridgeCall, type BridgeCall, type BridgeReply } from "./bridge.js";
export { HandoffError, createPass, redactPage, type Pass, type PassBrowser, type PassEvent, type PassOptions } from "./pass.js";
export { createLogins, fillUsername, frameBrowser, isLocalHost, loginGate, loginHost, type FillEnd, type LoginEvent, type LoginRecord, type LoginStore, type LoginVault, type Logins, type LoginsOptions } from "./logins.js";
