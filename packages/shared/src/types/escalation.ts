export type EscalationType = 'ask_human' | 'ask_ai' | 'report_blocker';

export interface EscalationRequest {
  id: string;
  sessionId: string;
  type: EscalationType;
  timestamp: string;
  payload: AskHumanPayload | AskAiPayload | ReportBlockerPayload;
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

export interface EscalationResponse {
  respondedAt: string;
  respondedBy: 'human' | 'ai';
  response: string;
  model?: string;
}
