import type { PendingRequests } from '../pending-requests.js';
import type { SessionBridge } from '../session-bridge.js';
import { generateId } from '@autopod/shared';
import type { EscalationRequest } from '@autopod/shared';

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

  const response = await pendingRequests.waitForResponse(escalationId, timeoutMs);
  return response;
}
