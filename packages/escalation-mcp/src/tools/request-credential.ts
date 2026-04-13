import { generateId } from '@autopod/shared';
import type { EscalationRequest } from '@autopod/shared';
import type { PendingRequests } from '../pending-requests.js';
import type { SessionBridge } from '../session-bridge.js';

export interface RequestCredentialInput {
  service: 'github' | 'ado';
  reason: string;
}

export async function requestCredential(
  sessionId: string,
  input: RequestCredentialInput,
  bridge: SessionBridge,
  pendingRequests: PendingRequests,
): Promise<string> {
  const escalationId = generateId();
  const timeoutMs = bridge.getHumanResponseTimeout(sessionId) * 1000;

  const escalation: EscalationRequest = {
    id: escalationId,
    sessionId,
    type: 'request_credential',
    timestamp: new Date().toISOString(),
    payload: {
      service: input.service,
      reason: input.reason,
    },
    response: null,
  };

  bridge.createEscalation(escalation);
  bridge.incrementEscalationCount(sessionId);

  try {
    return await pendingRequests.waitForResponse(escalationId, timeoutMs);
  } catch (err) {
    const isTimeout = err instanceof Error && err.message.includes('timed out');
    return isTimeout
      ? `[Credential request for ${input.service} timed out. No credentials were injected.]`
      : `[Credential request cancelled: ${err instanceof Error ? err.message : String(err)}]`;
  }
}
