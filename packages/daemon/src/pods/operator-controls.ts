import type { EscalationRequest } from '@autopod/shared';
import { AutopodError } from '@autopod/shared';
import type { OperatorBulkCalls, OperatorControlsCaptured } from './operator-contracts.js';
import { canNudge } from './state-machine.js';
export function createOperatorControls(captured: OperatorControlsCaptured) {
  const { podRepo, nudgeRepo, emitActivityStatus, logger, transition } = captured;
  function nudgeSession(podId: string, message: string): void {
    const pod = podRepo.getOrThrow(podId);
    if (!canNudge(pod.status)) {
      throw new AutopodError(
        `Cannot nudge pod ${podId} in status ${pod.status}`,
        'INVALID_STATE',
        409,
      );
    }

    nudgeRepo.queue(podId, message);
    emitActivityStatus(podId, `Nudge queued: ${message}`);
    logger.info({ podId }, 'Nudge message queued');
  }

  function notifyEscalation(podId: string, escalation: EscalationRequest): void {
    const pod = podRepo.getOrThrow(podId);
    if (pod.status === 'running') {
      transition(pod, 'awaiting_input', {
        pendingEscalation: escalation,
        escalationCount: pod.escalationCount + 1,
      });
    }
  }

  async function killAllFailed(this: OperatorBulkCalls): Promise<{ killed: string[] }> {
    const failed = podRepo.list({ status: 'failed' });
    const killed: string[] = [];
    for (const pod of failed) {
      try {
        await this.killSession(pod.id);
        killed.push(pod.id);
      } catch (err) {
        logger.warn({ err, podId: pod.id }, 'Failed to kill pod in bulk');
      }
    }
    return { killed };
  }
  return { nudgeSession, notifyEscalation, killAllFailed };
}
