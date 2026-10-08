import { generateId } from '@autopod/shared';
import type { EscalationRequest } from '@autopod/shared';
import type { PendingRequests } from '../pending-requests.js';
import type { PodBridge } from '../pod-bridge.js';

export interface ReportBlockerInput {
  description: string;
  attempted: string[];
  needs: string;
}

export async function reportBlocker(
  podId: string,
  input: ReportBlockerInput,
  bridge: PodBridge,
  pendingRequests: PendingRequests,
): Promise<string> {
  const escalationId = generateId();
  const autoPauseThreshold = bridge.getAutoPauseThreshold(podId);
  const currentCount = bridge.getAutoPauseCount(podId);

  const requiresResponse = currentCount + 1 >= autoPauseThreshold;
  const escalation: EscalationRequest = {
    id: escalationId,
    podId,
    type: 'report_blocker',
    timestamp: new Date().toISOString(),
    payload: {
      requiresResponse,
      description: input.description,
      attempted: input.attempted,
      needs: input.needs,
    },
    response: null,
  };

  bridge.createEscalation(escalation);
  bridge.incrementEscalationCount(podId);

  if (requiresResponse) {
    // Block and wait for human
    const timeoutMs = bridge.getHumanResponseTimeout(podId) * 1000;
    try {
      const response = await pendingRequests.waitForResponse(escalationId, timeoutMs);
      return response;
    } catch (err) {
      const isTimeout = err instanceof Error && err.message.includes('timed out');
      return isTimeout
        ? 'Blocker reported, but no human response arrived before the timeout. The pod remains awaiting input; do not continue work until the operator responds.'
        : `Blocker response wait was cancelled: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  return `Blocker reported: ${input.description}. Continuing with reduced confidence.`;
}
