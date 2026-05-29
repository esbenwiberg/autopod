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
  const currentCount = bridge.getReportBlockerCount(podId);
  const shouldNotifyHuman = currentCount + 1 >= autoPauseThreshold;

  const escalation: EscalationRequest = {
    id: escalationId,
    podId,
    type: 'report_blocker',
    timestamp: new Date().toISOString(),
    payload: {
      description: input.description,
      attempted: input.attempted,
      needs: input.needs,
    },
    response: null,
  };

  bridge.createEscalation(escalation, { notifyHuman: shouldNotifyHuman });

  if (shouldNotifyHuman) {
    bridge.incrementEscalationCount(podId);
    // Block and wait for human
    const timeoutMs = bridge.getHumanResponseTimeout(podId) * 1000;
    const response = await pendingRequests.waitForResponse(escalationId, timeoutMs);
    return response;
  }

  return `Blocker reported: ${input.description}. Continuing with reduced confidence.`;
}
