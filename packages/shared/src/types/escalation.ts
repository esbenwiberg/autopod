export type EscalationType =
  | 'ask_human'
  | 'ask_ai'
  | 'report_blocker'
  | 'action_approval'
  | 'validation_override'
  | 'request_credential';

export interface EscalationRequest {
  id: string;
  podId: string;
  type: EscalationType;
  timestamp: string;
  payload:
    | AskHumanPayload
    | AskAiPayload
    | ReportBlockerPayload
    | ActionApprovalPayload
    | ValidationOverridePayload
    | RequestCredentialPayload;
  response: EscalationResponse | null;
}

export interface AskHumanPayload {
  question: string;
  context?: string;
  options?: string[];
}

export interface AskAiPayload {
  question: string;
  context?: string;
  domain?: string;
}

export interface ReportBlockerPayload {
  description: string;
  attempted: string[];
  needs: string;
}

export interface ActionApprovalPayload {
  actionName: string;
  params: Record<string, unknown>;
  description: string;
  /** Handler-specific context captured before the approval was requested (e.g. deploy script hash). */
  approvalContext?: Record<string, unknown>;
}

export interface ValidationOverridePayload {
  findings: import('./validation.js').ValidationFinding[];
  attempt: number;
  maxAttempts: number;
}

export interface RequestCredentialPayload {
  /** Which service to authenticate against */
  service: 'github' | 'ado';
  /** Human-readable reason the agent needs this credential */
  reason: string;
}

export interface EscalationResponse {
  respondedAt: string;
  respondedBy: 'human' | 'ai';
  response: string;
  model?: string;
}
