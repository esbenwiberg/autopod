import { generateId } from '@autopod/shared';
import type { EscalationRequest } from '@autopod/shared';
import type { PendingRequests } from '../pending-requests.js';
import type { PodBridge } from '../pod-bridge.js';

export interface AskHumanInput {
  question: string;
  kind?: 'decision';
  recommendation?: string;
  context?: string;
  options?: string[];
}

export async function askHuman(
  podId: string,
  input: AskHumanInput,
  bridge: PodBridge,
  pendingRequests: PendingRequests,
): Promise<string> {
  // Series unattended mode: redirect to AI instead of blocking for a human
  if (bridge.isAskHumanDisabled(podId) && input.kind !== 'decision') {
    const { response: aiResponse } = await bridge.callAdvisorModel(
      podId,
      input.question,
      input.context,
    );
    return `[Auto-routed to AI — ask_human is disabled for this series]\n\n${aiResponse}`;
  }

  const escalationId = generateId();
  const timeoutMs = bridge.getHumanResponseTimeout(podId) * 1000;

  const escalation: EscalationRequest = {
    id: escalationId,
    podId,
    type: 'ask_human',
    timestamp: new Date().toISOString(),
    payload: {
      question: input.question,
      kind: input.kind,
      recommendation: input.recommendation,
      context: input.context,
      options: input.options,
    },
    response: null,
  };

  bridge.createEscalation(escalation);
  bridge.incrementEscalationCount(podId);

  try {
    const response = await pendingRequests.waitForResponse(escalationId, timeoutMs);
    bridge.resolveEscalation(escalationId, {
      response,
      respondedBy: 'human',
      respondedAt: new Date().toISOString(),
    });
    bridge.logEscalationAnswer(podId, 'human', response);
    return response;
  } catch (err) {
    // Timeout or cancellation — return a message rather than throwing INTERNAL_ERROR
    const isTimeout = err instanceof Error && err.message.includes('timed out');
    if (
      isTimeout &&
      input.kind !== 'decision' &&
      bridge.getHumanResponseOnTimeout(podId) === 'ask_ai'
    ) {
      const { response: aiResponse, model } = await bridge.callAdvisorModel(
        podId,
        input.question,
        input.context,
      );
      bridge.resolveEscalation(escalationId, {
        response: aiResponse,
        respondedBy: 'ai',
        model,
        respondedAt: new Date().toISOString(),
      });
      bridge.logEscalationAnswer(podId, 'ai', aiResponse);
      return `[Auto-routed to AI after ask_human timeout]\n\n${aiResponse}`;
    }
    return isTimeout
      ? '[No response received. The decision remains unanswered. Stop dependent work; preserve source and finish for owned finalization. Timeout grants no authority or gate waiver.]'
      : `[Escalation cancelled: ${err instanceof Error ? err.message : String(err)}]`;
  }
}
