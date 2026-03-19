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
  reportPlan(sessionId: string, summary: string, steps: string[]): void;
  reportProgress(sessionId: string, phase: string, description: string, currentPhase: number, totalPhases: number): void;
  consumeMessages(sessionId: string): { hasMessage: boolean; message?: string };
}
