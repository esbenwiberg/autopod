import { generateId } from '@autopod/shared';
import type { EscalationRequest } from '@autopod/shared';
import type { PendingRequests } from '../pending-requests.js';
import type { SessionBridge } from '../session-bridge.js';

export interface ReportBlockerInput {
  description: string;
  attempted: string[];
  needs: string;
}

export async function reportBlocker(
  sessionId: string,
  input: ReportBlockerInput,
  bridge: SessionBridge,
  pendingRequests: PendingRequests,
): Promise<string> {
  const escalationId = generateId();
  const autoPauseThreshold = bridge.getAutoPauseThreshold(sessionId);
  const currentCount = bridge.getAiEscalationCount(sessionId);

  const escalation: EscalationRequest = {
    id: escalationId,
    sessionId,
    type: 'report_blocker',
    timestamp: new Date().toISOString(),
    payload: {
      description: input.description,
      attempted: input.attempted,
      needs: input.needs,
    },
    response: null,
  };

  bridge.createEscalation(escalation);
  bridge.incrementEscalationCount(sessionId);

  if (currentCount + 1 >= autoPauseThreshold) {
    // Block and wait for human
    const timeoutMs = bridge.getHumanResponseTimeout(sessionId) * 1000;
    const response = await pendingRequests.waitForResponse(escalationId, timeoutMs);
    return response;
  }

  return `Blocker reported: ${input.description}. Continuing with reduced confidence.`;
}
