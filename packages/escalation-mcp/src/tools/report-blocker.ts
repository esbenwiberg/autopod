import { generateId } from '@autopod/shared';
import type { EscalationRequest } from '@autopod/shared';
import type { PendingRequests } from '../pending-requests.js';
import type { PodBridge } from '../pod-bridge.js';

export interface ReportBlockerInput {
  description: string;
  attempted: string[];
  needs: string;
  owner?: 'autopod' | 'parent' | 'validation';
  phase?: string;
}

export async function reportBlocker(
  podId: string,
  input: ReportBlockerInput,
  bridge: PodBridge,
  _pendingRequests: PendingRequests,
): Promise<string> {
  const escalationId = generateId();
  const escalation: EscalationRequest = {
    id: escalationId,
    podId,
    type: 'report_blocker',
    timestamp: new Date().toISOString(),
    payload: {
      kind: 'infrastructure',
      owner: input.owner ?? 'autopod',
      phase: input.phase,
      requiresResponse: false,
      description: input.description,
      attempted: input.attempted,
      needs: input.needs,
    },
    response: null,
  };

  bridge.createEscalation(escalation);
  bridge.incrementEscalationCount(podId);

  return `Infrastructure blocker recorded: ${input.description}. No human answer is requested. Stop blocked attempts; preserve work and report incomplete checks in report_task_summary, then finish. Autopod will hold completion after execution settles. This report is not a validation receipt, permission, or gate waiver.`;
}
