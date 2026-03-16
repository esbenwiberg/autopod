import type { SessionBridge } from '../session-bridge.js';
import { generateId } from '@autopod/shared';
import type { EscalationRequest } from '@autopod/shared';

export interface AskAiInput {
  question: string;
  context?: string;
  domain?: string;
}

export async function askAi(
  sessionId: string,
  input: AskAiInput,
  bridge: SessionBridge,
): Promise<string> {
  // Check rate limit
  const currentCount = bridge.getAiEscalationCount(sessionId);
  const maxCalls = bridge.getMaxAiCalls(sessionId);

  if (currentCount >= maxCalls) {
    throw new Error(`AI escalation limit reached (${maxCalls}). Use ask_human instead.`);
  }

  const escalationId = generateId();

  const escalation: EscalationRequest = {
    id: escalationId,
    sessionId,
    type: 'ask_ai',
    timestamp: new Date().toISOString(),
    payload: {
      question: input.question,
      context: input.context,
      domain: input.domain,
    },
    response: null,
  };

  bridge.createEscalation(escalation);

  // Call the reviewer model directly (no need to wait for human)
  const response = await bridge.callReviewerModel(sessionId, input.question, input.context);

  // Resolve the escalation
  bridge.resolveEscalation(escalationId, {
    respondedAt: new Date().toISOString(),
    respondedBy: 'ai',
    response,
    model: bridge.getReviewerModel(sessionId),
  });

  bridge.incrementEscalationCount(sessionId);
  return response;
}
