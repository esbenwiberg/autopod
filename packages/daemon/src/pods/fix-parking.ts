import type { Pod, RequestCredentialPayload } from '@autopod/shared';
import { GitCredentialError } from '../worktrees/local-worktree-manager.js';
import type { FixParkingCaptured } from './fix-contracts.js';
import { FIX_DELIVERY_FAILED_PREFIX } from './fix-policy.js';
export function createFixParking(captured: FixParkingCaptured) {
  const { parkOnCredentialFailure, logger, emitActivityStatus, transition } = captured;
  function parkFixPodDeliveryFailure(fixPod: Pod, err: unknown): void {
    if (err instanceof GitCredentialError) {
      parkOnCredentialFailure(fixPod.id, err);
      return;
    }

    const message = err instanceof Error ? err.message : String(err);
    logger.warn({ err, podId: fixPod.id }, 'Fix-pod post-validation push failed — parking');
    emitActivityStatus(
      fixPod.id,
      `Fix branch push failed — awaiting operator retry; no AI retry started: ${message}`,
    );
    transition(fixPod, 'awaiting_input', {
      mergeBlockReason: `${FIX_DELIVERY_FAILED_PREFIX}: ${message}`,
    });
  }

  function isParkedHostPushRecovery(pod: Pod): boolean {
    if (pod.status !== 'awaiting_input') return false;
    if (pod.mergeBlockReason?.startsWith(FIX_DELIVERY_FAILED_PREFIX)) return true;
    if (pod.pendingEscalation?.type !== 'request_credential') return false;
    const payload = pod.pendingEscalation.payload as RequestCredentialPayload;
    return payload.source === 'host_push';
  }

  function isRetryableFixDeliveryFailure(pod: Pod): boolean {
    if (pod.status !== 'awaiting_input' && pod.status !== 'failed') return false;
    return (
      !!pod.linkedPodId &&
      pod.lastValidationResult?.overall === 'pass' &&
      pod.mergeBlockReason?.startsWith(FIX_DELIVERY_FAILED_PREFIX) === true
    );
  }
  return { parkFixPodDeliveryFailure, isParkedHostPushRecovery, isRetryableFixDeliveryFailure };
}
