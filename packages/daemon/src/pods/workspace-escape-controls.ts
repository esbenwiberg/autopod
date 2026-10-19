import type { OperatorActor } from '@autopod/shared';
import { AutopodError } from '@autopod/shared';
import { actorLabel } from './approval-policy.js';
import type { WorkspaceEscapeCaptured } from './workspace-contracts.js';

export function createWorkspaceEscapeControls(captured: WorkspaceEscapeCaptured) {
  const {
    podRepo,
    cleanupContainer,
    transition,
    emitActivityStatus,
    logger,
    maybeTriggerDependents,
    clearStuckQueueEntry,
    enqueueSession,
    validationAbortControllers,
  } = captured;

  async function forceComplete(
    podId: string,
    reason?: string,
    actor: OperatorActor = { type: 'automation', id: 'direct-pod-manager' },
  ): Promise<void> {
    podRepo.deletionOwnership?.assertTaskAvailable(podId);
    const pod = podRepo.getOrThrow(podId);
    if (pod.status === 'complete') {
      throw new AutopodError(`Pod ${podId} is already complete`, 'INVALID_STATE', 409);
    }
    if (pod.status !== 'failed') {
      throw new AutopodError(
        `Cannot force-complete pod ${podId} in status ${pod.status} — only failed pods are eligible`,
        'INVALID_STATE',
        409,
      );
    }

    // Force-complete is terminal — kill+remove the container so it doesn't
    // linger as a stopped record in Docker. Bounded so a wedged engine can't
    // hang the operator endpoint.
    await cleanupContainer(pod, 'force-complete');

    const trimmedReason = reason?.trim() || null;
    const now = new Date().toISOString();
    podRepo.update(podId, {
      forceCompletedAt: now,
      forceCompletedReason: trimmedReason,
    });
    transition(pod, 'complete');
    emitActivityStatus(
      podId,
      trimmedReason
        ? `Force-completed by ${actorLabel(actor)}: ${trimmedReason}`
        : `Force-completed by ${actorLabel(actor)}`,
    );
    logger.warn(
      { podId, reason: trimmedReason },
      'Pod force-completed by operator (admin override — push/PR/merge skipped)',
    );

    // Series children that were waiting on this pod must be triggered just
    // like a normal completion — otherwise the entire downstream series
    // stalls in `queued` forever and the operator has to manually `kick`
    // each dependent. The whole point of force-complete is to unstick a
    // series, so silently failing to advance it is a footgun.
    const completedPod = podRepo.getOrThrow(podId);
    maybeTriggerDependents(completedPod);
  }

  async function kickPod(
    podId: string,
    reason?: string,
    actor: OperatorActor = { type: 'automation', id: 'direct-pod-manager' },
  ): Promise<{ action: 'requeued' | 'failed' }> {
    const pod = podRepo.getOrThrow(podId);
    const trimmedReason = reason?.trim() || null;
    const nowIso = new Date().toISOString();

    if (pod.status === 'queued') {
      // A pod that has been in `queued` long enough for an operator to kick is
      // past any live processPod (status would have moved to provisioning). If the
      // queue still tracks it as active, that's a stale entry from a previous run
      // whose finally never ran — clear it so the upcoming enqueue isn't silently
      // dedup'd. Without this, the kick endpoint reports success but the pod sits
      // forever because `enqueue`'s `activeIds.has(podId)` check returns true.
      const cleared = clearStuckQueueEntry?.(podId) ?? false;
      podRepo.update(podId, { kickedAt: nowIso, kickedReason: trimmedReason });
      enqueueSession(podId);
      emitActivityStatus(
        podId,
        trimmedReason
          ? `Re-enqueued by ${actorLabel(actor)}: ${trimmedReason}`
          : `Re-enqueued by ${actorLabel(actor)}`,
      );
      logger.warn(
        { podId, reason: trimmedReason, clearedStuckEntry: cleared },
        'Pod kicked by operator — re-enqueued from queued',
      );
      return { action: 'requeued' };
    }

    if (pod.status === 'running' || pod.status === 'provisioning' || pod.status === 'validating') {
      // Bounded — the whole point of kick is to free a slot when something
      // upstream (often Docker itself) is wedged. The transition to `failed`
      // must not depend on Docker cooperating. Mode='stop' so a subsequent
      // `resume` can still restart the same container if Docker recovers.
      validationAbortControllers.get(podId)?.abort();
      await cleanupContainer(pod, 'kick', 'stop');
      podRepo.update(podId, { kickedAt: nowIso, kickedReason: trimmedReason });
      transition(pod, 'failed', { completedAt: nowIso });
      emitActivityStatus(
        podId,
        trimmedReason
          ? `Kicked by ${actorLabel(actor)} (force-failed): ${trimmedReason}`
          : `Kicked by ${actorLabel(actor)} (force-failed)`,
      );
      logger.warn(
        { podId, previousStatus: pod.status, reason: trimmedReason },
        'Pod kicked by operator — transitioned to failed',
      );
      return { action: 'failed' };
    }

    throw new AutopodError(
      `Cannot kick pod ${podId} in status ${pod.status} — only queued/running/provisioning/validating are eligible`,
      'INVALID_STATE',
      409,
    );
  }
  return { forceComplete, kickPod };
}
