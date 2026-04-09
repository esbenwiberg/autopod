export type EscalationType =
  | 'ask_human'
  | 'ask_ai'
  | 'report_blocker'
  | 'action_approval'
  | 'validation_override';

export interface EscalationRequest {
  id: string;
  sessionId: string;
  type: EscalationType;
  timestamp: string;
  payload:
    | AskHumanPayload
    | AskAiPayload
    | ReportBlockerPayload
    | ActionApprovalPayload
    | ValidationOverridePayload;
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
}

export interface ValidationOverridePayload {
  findings: import('./validation.js').ValidationFinding[];
  attempt: number;
  maxAttempts: number;
}

export interface EscalationResponse {
  respondedAt: string;
  respondedBy: 'human' | 'ai';
  response: string;
  model?: string;
}
