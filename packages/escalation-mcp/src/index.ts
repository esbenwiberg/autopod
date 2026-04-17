export { createEscalationMcpServer, type EscalationMcpDeps } from './server.js';
export { PendingRequests } from './pending-requests.js';
export type { PodBridge } from './pod-bridge.js';
export { askHuman, type AskHumanInput } from './tools/ask-human.js';
export { askAi, type AskAiInput } from './tools/ask-ai.js';
export { reportBlocker, type ReportBlockerInput } from './tools/report-blocker.js';
export { executeAction } from './tools/actions.js';
export {
  validateInBrowser,
  type ValidateInBrowserInput,
  type ValidateInBrowserResult,
  type BrowserCheckResult,
} from './tools/validate-in-browser.js';

export const ESCALATION_MCP_VERSION = '0.0.1';
