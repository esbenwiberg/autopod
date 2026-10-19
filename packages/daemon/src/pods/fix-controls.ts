import type { SpawnFixResponse } from '@autopod/shared';
import { AutopodError, DEFAULT_MAX_PR_FIX_ATTEMPTS } from '@autopod/shared';
import type { PrMergeStatus } from '../interfaces/index.js';
import type { FixControlsCaptured } from './fix-contracts.js';
import type { PodUpdates } from './pod-repository.js';
export function createFixControls(captured: FixControlsCaptured) {
  const {
    podRepo,
    executionForPod,
    transition,
    emitActivityStatus,
    startMergePolling,
    logger,
    fixFeedbackRepo,
    maybeSpawnFixSession,
    isFixCycleTerminal,
  } = captured;
  async function extendPrAttempts(podId: string, additionalAttempts: number): Promise<void> {
    const pod = podRepo.getOrThrow(podId);
    if (pod.status !== 'failed') {
      throw new AutopodError(
        `Cannot extend PR attempts for pod ${podId} in status ${pod.status} — only failed pods`,
        'INVALID_STATE',
        409,
      );
    }
    if (!pod.mergeBlockReason?.startsWith('Max PR fix attempts')) {
      throw new AutopodError(
        `Pod ${podId} did not fail due to exhausted PR fix attempts`,
        'INVALID_STATE',
        409,
      );
    }
    const currentMax = pod.maxPrFixAttempts ?? DEFAULT_MAX_PR_FIX_ATTEMPTS;
    const newMax = currentMax + additionalAttempts;
    if (newMax > 20) {
      throw new AutopodError(
        `Cannot exceed 20 total PR fix attempts (current: ${currentMax}, requested: +${additionalAttempts})`,
        'VALIDATION_ERROR',
        400,
      );
    }
    // Clear stale fixPodId so the next poll can spawn freely.
    // Skip the clear when `reuseFixPod` is enabled — that path INTENTIONALLY
    // wants to find the previous (terminal-state) fix pod and re-enqueue it
    // instead of spawning a new child, preserving the one-fix-pod-per-PR
    // invariant the user sees in the UI.
    const profile = executionForPod(pod);
    const updates: PodUpdates = { maxPrFixAttempts: newMax };
    if (profile.reuseFixPod !== true) {
      updates.fixPodId = null;
    }
    podRepo.update(podId, updates);
    // failed → merge_pending re-enters the polling loop
    transition(pod, 'merge_pending', {
      mergeBlockReason: 'Awaiting merge — PR fix attempts extended',
    });
    emitActivityStatus(podId, `PR fix attempts extended to ${newMax} — resuming merge polling`);
    startMergePolling(podId);
    logger.info(
      { podId, oldMax: currentMax, newMax, additionalAttempts },
      'Extended PR fix attempts',
    );
  }

  async function spawnFixSession(podId: string, userMessage?: string): Promise<void> {
    const pod = podRepo.getOrThrow(podId);
    // Fix pods are tied to a `merge_pending` parent whose poller owns the
    // actual PR merge. A terminal parent (complete/failed/killed) has a
    // stopped poller — there is nothing left to drive the merge, so spawning
    // a fix pod for it would strand the fix pod's commits.
    if (pod.status !== 'merge_pending') {
      throw new AutopodError(
        `Cannot spawn fix pod for ${podId} in status ${pod.status} — only merge_pending pods`,
        'INVALID_STATE',
        409,
      );
    }
    if (pod.linkedPodId) {
      throw new AutopodError(
        `Pod ${podId} is already a fix pod — only root pods can spawn fixers`,
        'INVALID_STATE',
        409,
      );
    }
    // In a single-PR series only the PR-owning pod has prUrl set, but the user
    // may legitimately click a sibling. resolveBranchSource will route the fix
    // pod to the PR owner; we just need a series anchor here.
    const isSingleSeriesMember = pod.prMode === 'single' && Boolean(pod.seriesId);
    if (!pod.prUrl && !isSingleSeriesMember) {
      throw new AutopodError(`Pod ${podId} has no PR URL`, 'INVALID_STATE', 409);
    }

    // Bump maxPrFixAttempts if the current cap would block the spawn
    const currentMax = pod.maxPrFixAttempts ?? DEFAULT_MAX_PR_FIX_ATTEMPTS;
    const currentAttempts = pod.prFixAttempts ?? 0;
    if (currentAttempts >= currentMax) {
      const newMax = Math.min(currentAttempts + 3, 20);
      podRepo.update(podId, { maxPrFixAttempts: newMax });
      logger.info(
        { podId, currentAttempts, newMax },
        'Manual spawn: bumped maxPrFixAttempts to allow fix',
      );
    }

    const message = userMessage?.trim() || 'Manual fix pod spawn — address the PR feedback.';
    fixFeedbackRepo.enqueue(podId, message);

    const status: PrMergeStatus = {
      merged: false,
      open: true,
      blockReason: pod.mergeBlockReason ?? 'PR needs fixes',
      ciFailures: [],
      reviewComments: [],
    };
    await maybeSpawnFixSession(podId, status);
    logger.info({ podId, hasUserMessage: Boolean(userMessage) }, 'Manual fix pod spawn triggered');
  }

  async function requestFixSession(podId: string, message: string): Promise<SpawnFixResponse> {
    // getOrThrow surfaces PodNotFoundError → 404 at the route layer.
    const pod = podRepo.getOrThrow(podId);
    if (pod.linkedPodId) {
      throw new AutopodError(
        `Pod ${podId} is a fix pod — only root pods can spawn fixers`,
        'INVALID_STATE',
        409,
      );
    }
    // A terminal parent has nothing left to fix — report it as a structured
    // result, not an exception, so the API can return a clean 409 body.
    if (isFixCycleTerminal(pod.status)) {
      return { ok: false, reason: 'parent_terminal' };
    }

    fixFeedbackRepo.enqueue(podId, message);

    const status: PrMergeStatus = {
      merged: false,
      open: true,
      blockReason: pod.mergeBlockReason ?? 'PR needs fixes',
      ciFailures: [],
      reviewComments: [],
    };
    await maybeSpawnFixSession(podId, status);

    const updated = podRepo.getOrThrow(podId);
    // maybeSpawnFixSession fails the parent when the PR-fix attempt cap is
    // exhausted. A now-terminal parent is reported the same way as one that
    // was already terminal on entry — there is nothing left to fix.
    if (isFixCycleTerminal(updated.status)) {
      return { ok: false, reason: 'parent_terminal' };
    }
    const queueLength = fixFeedbackRepo.count(podId);
    return {
      ok: true,
      queued: queueLength > 0,
      queueLength,
      fixPodId: updated.fixPodId ?? null,
    };
  }
  return { extendPrAttempts, spawnFixSession, requestFixSession };
}
