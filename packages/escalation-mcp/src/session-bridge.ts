import type { EscalationRequest, EscalationResponse } from '@autopod/shared';

export interface SessionBridge {
  createEscalation(escalation: EscalationRequest): void;
  resolveEscalation(escalationId: string, response: EscalationResponse): void;
  getAiEscalationCount(sessionId: string): number;
  getMaxAiCalls(sessionId: string): number;
  getAutoPauseThreshold(sessionId: string): number;
  getHumanResponseTimeout(sessionId: string): number;
  getReviewerModel(sessionId: string): string;
  callReviewerModel(sessionId: string, question: string, context?: string): Promise<string>;
  incrementEscalationCount(sessionId: string): void;
}
