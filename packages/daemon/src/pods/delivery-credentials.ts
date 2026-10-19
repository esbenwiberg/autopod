import type { EscalationRequest } from '@autopod/shared';
import { generateId } from '@autopod/shared';
import type { GitCredentialError } from '../worktrees/local-worktree-manager.js';
import type { DeliveryCredentialsCaptured } from './delivery-contracts.js';
import { persistEscalation } from './escalation-coordinator.js';

export function createDeliveryCredentials(captured: DeliveryCredentialsCaptured) {
  const { podRepo, escalationRepo, transition, emitActivityStatus, logger } = captured;
  function parkOnCredentialFailure(podId: string, err: GitCredentialError): true {
    const pod = podRepo.getOrThrow(podId);
    const escalation: EscalationRequest = {
      id: generateId(12),
      podId,
      type: 'request_credential',
      timestamp: new Date().toISOString(),
      payload: {
        service: err.service,
        reason:
          err.service === 'github'
            ? `git ${err.op} was rejected by GitHub. Authenticate the daemon service account with gh auth login and ensure it has write access to the target repo, then resume the pod.`
            : `git ${err.op} was rejected by ADO. Sign the daemon host into the correct Azure CLI identity, verify that identity has repository access, then resume the pod.`,
        source: 'host_push',
      },
      response: null,
    };
    persistEscalation(podRepo, escalationRepo, escalation, () => {
      transition(pod, 'awaiting_input', {
        pendingEscalation: escalation,
        escalationCount: pod.escalationCount + 1,
      });
    });
    emitActivityStatus(
      podId,
      `Push blocked — ${err.service} credentials missing or unauthorized. Repair daemon authentication and resume.`,
    );
    logger.warn(
      { podId, service: err.service, op: err.op, escalationId: escalation.id },
      'Daemon-side git push parked in awaiting_input on credential failure',
    );
    return true;
  }
  return { parkOnCredentialFailure };
}
