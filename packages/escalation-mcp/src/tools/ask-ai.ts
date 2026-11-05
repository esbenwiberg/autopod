import type { EscalationRequest } from '@autopod/shared';
import { generateId } from '@autopod/shared';
import type { PodBridge } from '../pod-bridge.js';

export interface AskAiInput {
  question: string;
  context?: string;
  domain?: string;
}

export async function askAi(podId: string, input: AskAiInput, bridge: PodBridge): Promise<string> {
  // Check rate limit
  const currentCount = bridge.getAiEscalationCount(podId);
  const maxCalls = bridge.getMaxAiCalls(podId);

  if (currentCount >= maxCalls) {
    throw new Error(
      `AI escalation limit reached (${maxCalls}). Use ask_human only for an actionable owner decision; report infrastructure with report_blocker and stop blocked attempts.`,
    );
  }

  const escalationId = generateId();

  const escalation: EscalationRequest = {
    id: escalationId,
    podId,
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

  // Call Advisor directly (no need to wait for human)
  const { response, model } = await bridge.callAdvisorModel(podId, input.question, input.context);

  // Resolve the escalation
  bridge.resolveEscalation(escalationId, {
    respondedAt: new Date().toISOString(),
    respondedBy: 'ai',
    response,
    model,
  });

  bridge.incrementEscalationCount(podId);
  return response;
}
