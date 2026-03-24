import { generateId } from '@autopod/shared';
import type { EscalationRequest } from '@autopod/shared';
import type { PendingRequests } from '../pending-requests.js';
import type { SessionBridge } from '../session-bridge.js';

export interface AskHumanInput {
  question: string;
  context?: string;
  options?: string[];
}

export async function askHuman(
  sessionId: string,
  input: AskHumanInput,
  bridge: SessionBridge,
  pendingRequests: PendingRequests,
): Promise<string> {
  const escalationId = generateId();
  const timeoutMs = bridge.getHumanResponseTimeout(sessionId) * 1000;

  const escalation: EscalationRequest = {
    id: escalationId,
    sessionId,
    type: 'ask_human',
    timestamp: new Date().toISOString(),
    payload: {
      question: input.question,
      context: input.context,
      options: input.options,
    },
    response: null,
  };

  bridge.createEscalation(escalation);
  bridge.incrementEscalationCount(sessionId);

  try {
    const response = await pendingRequests.waitForResponse(escalationId, timeoutMs);
    return response;
  } catch (err) {
    // Timeout or cancellation — return a message rather than throwing INTERNAL_ERROR
    const isTimeout = err instanceof Error && err.message.includes('timed out');
    return isTimeout
      ? `[No response received within the timeout period. Please check in with the human separately and continue with your best judgement.]`
      : `[Escalation cancelled: ${err instanceof Error ? err.message : String(err)}]`;
  }
}
