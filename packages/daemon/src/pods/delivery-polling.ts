import type { PodStatus } from '@autopod/shared';
import { AutopodError } from '@autopod/shared';
import {
  closedPrRecoveryReason,
  inspectRetainedMergeSource,
  mergePublishedSource,
  reconcileMerge,
} from '../worktrees/durable-merge.js';
import { mergeReconciliation } from '../worktrees/merge-source-identity.js';
import type { DeliveryPollingCaptured } from './delivery-contracts.js';
import type { PollOwnership } from './polling-coordinator.js';

export function createDeliveryPolling(captured: DeliveryPollingCaptured) {
  const {
    podRepo,
    assertApprovalCurrent,
    executionForPod,
    prManagerFactory,
    transition,
    emitActivityStatus,
    worktreeManager,
    mergeQueue,
    cleanupContainer,
    eventBus,
    logger,
    maybeTriggerDependents,
    buildActionableFailureSummary,
    fixFeedbackRepo,
    maybeSpawnFixSession,
    DEFAULT_MERGE_POLL_INTERVAL_MS,
    mergePolling,
  } = captured;
  function startMergePolling(podId: string): void {
    const generation = podRepo.getOrThrow(podId).lifecycleGeneration;

    const poll = async (ownership: PollOwnership) => {
      try {
        const pod = podRepo.getOrThrow(podId);
        if (pod.status !== 'merge_pending' || pod.lifecycleGeneration !== generation) {
          ownership.stop();
          return;
        }

        if (!pod.prUrl) {
          ownership.stop();
          return;
        }

        const assertCurrent = (
          options: { allowRemovedContainer?: boolean; status?: PodStatus } = {},
        ) => {
          if (!ownership.isCurrent())
            throw new AutopodError('Merge polling ownership was replaced.', 'STALE_APPROVAL', 409);
          assertApprovalCurrent(
            { ...pod, status: options.status ?? pod.status },
            { allowRemovedContainer: options.allowRemovedContainer },
          );
          if (podRepo.getOrThrow(podId).prUrl !== pod.prUrl)
            throw new AutopodError(
              'Merge polling was superseded by another PR.',
              'STALE_APPROVAL',
              409,
            );
        };
        const pollOperation = async <T>(operation: () => Promise<T>): Promise<T> => {
          assertCurrent();
          try {
            return await operation();
          } finally {
            assertCurrent();
          }
        };
        assertCurrent();
        const profile = executionForPod(pod);
        const prManager = prManagerFactory ? prManagerFactory(profile) : null;
        if (!prManager) {
          ownership.stop();
          return;
        }

        const journal = podRepo.mergeJournal;
        const entry = journal?.find(pod);
        if (!journal || !entry) {
          assertCurrent();
          const reason =
            'Delivery history is unavailable. Original resources retained. Use Resume to revalidate the retained source before approving delivery.';
          transition(pod, 'failed', { failureReason: reason, mergeBlockReason: reason });
          assertCurrent({ status: 'failed' });
          emitActivityStatus(podId, reason);
          ownership.stop();
          return;
        }

        const status = await pollOperation(async () =>
          prManager.getPrStatus({
            prUrl: pod.prUrl,
          }),
        );

        // Reconcile the planned or admitted source before any subsequent mutation.
        try {
          if (status.merged) {
            await pollOperation(() => reconcileMerge(journal, pod, entry, prManager, status));
            await pollOperation(() =>
              inspectRetainedMergeSource(
                journal,
                podRepo.sourcePublications,
                pod,
                entry,
                worktreeManager,
              ),
            );
          } else {
            if (status.open === false) {
              journal.observeStatus(entry.id, status);
              assertCurrent();
              const reason = closedPrRecoveryReason(entry);
              transition(pod, 'failed', { failureReason: reason, mergeBlockReason: reason });
              assertCurrent({ status: 'failed' });
              emitActivityStatus(podId, reason);
              ownership.stop();
              return;
            }
            if (entry.prDisposition === 'closed') journal.observeStatus(entry.id, status);
            if (
              (entry.state !== 'pending' && entry.state !== 'planned') ||
              entry.result?.autoMergeScheduled ||
              !status.open
            )
              mergeReconciliation(
                'The earlier merge requires source-bound provider reconciliation; original resources retained.',
              );
            const source = await pollOperation(() =>
              inspectRetainedMergeSource(
                journal,
                podRepo.sourcePublications,
                pod,
                entry,
                worktreeManager,
              ),
            );
            if (!status.ciFailures.length && !status.reviewComments.length) {
              const reviewOk = !status.reviewDecision || status.reviewDecision === 'APPROVED';
              const methodBlocked = status.squashRequired && !entry.request.config.squash;
              if (methodBlocked) status.blockReason = 'Branch policy requires squash merge';
              if (reviewOk && !status.mergeBlocked && !methodBlocked)
                await mergeQueue.enqueueMerge(
                  entry.request.config.expectedTarget.repository,
                  entry.request.config.expectedTarget.baseBranch,
                  async () => {
                    assertCurrent();
                    const result = await pollOperation(() =>
                      mergePublishedSource(
                        journal,
                        pod,
                        { ...pod, prUrl: entry.request.publicationPrUrl },
                        source,
                        prManager,
                        {
                          ...entry.request.config,
                          worktreePath: pod.worktreePath,
                          onPrepared: () => assertCurrent(),
                        },
                      ),
                    );
                    return result.merged;
                  },
                );
              assertCurrent();
              if (status.blockReason !== pod.mergeBlockReason) {
                podRepo.update(podId, { mergeBlockReason: status.blockReason });
                emitActivityStatus(
                  podId,
                  `Merge pending: ${status.blockReason ?? 'Waiting for confirmation'}`,
                );
              }
              // A later poll confirms cleanup. Never rebase or push over an
              // admitted request; a changed source needs its own validation.
              return;
            }
          }
        } catch (error) {
          assertCurrent();
          const reason = `Merge reconciliation required. ${error instanceof Error ? error.message : String(error)}`;
          if (pod.mergeBlockReason !== reason) {
            podRepo.update(podId, { mergeBlockReason: reason });
            emitActivityStatus(podId, reason);
          }
          return;
        }

        if (status.merged) {
          emitActivityStatus(podId, 'PR merged successfully');
          await cleanupContainer(pod, 'pr-merged-complete', 'kill', () =>
            assertCurrent({ allowRemovedContainer: true }),
          );
          assertCurrent({ allowRemovedContainer: true });
          const mergedPod = transition(pod, 'complete', {
            completedAt: new Date().toISOString(),
            mergeBlockReason: null,
          });

          assertCurrent({ allowRemovedContainer: true, status: 'complete' });
          eventBus.emit({
            type: 'pod.completed',
            timestamp: new Date().toISOString(),
            podId,
            finalStatus: 'complete',
            summary: {
              id: podId,
              profileName: pod.profileName,
              task: pod.task,
              status: 'complete',
              model: pod.model,
              runtime: pod.runtime,
              duration: pod.startedAt ? Date.now() - new Date(pod.startedAt).getTime() : null,
              filesChanged: pod.filesChanged,
              createdAt: pod.createdAt,
            },
          });

          logger.info({ podId, prUrl: pod.prUrl }, 'Merge polling: PR merged — pod complete');
          assertCurrent({ allowRemovedContainer: true, status: 'complete' });
          ownership.stop();
          maybeTriggerDependents(mergedPod);
          return;
        }

        // Still pending — update block reason if it changed
        if (status.blockReason !== pod.mergeBlockReason) {
          podRepo.update(podId, { mergeBlockReason: status.blockReason });
          emitActivityStatus(podId, `Merge pending: ${status.blockReason}`);
        }

        // Actionable failures → enqueue a sanitized summary, then ensure the
        // canonical fix pod is alive to drain it. The queue carries the
        // content so the drain at fix-pod start can build the task from a
        // minimal status (see processPod).
        //
        // Idempotency: a stuck PR re-emits the same failure signature on every
        // 60s tick. Without this guard the queue grows unboundedly (~one row
        // per minute) until the fix pod finally recycles — we've seen it hit
        // 391 rows across ~46h. Skip the enqueue when the latest queued summary
        // is byte-identical to the one we'd add. A new failure signature still
        // gets through.
        assertCurrent();
        if (status.ciFailures.length > 0 || status.reviewComments.length > 0) {
          const summary = buildActionableFailureSummary(status, profile);
          const latest = fixFeedbackRepo.peekLatest(podId);
          if (latest?.message !== summary) {
            fixFeedbackRepo.enqueue(podId, summary);
          }
          await pollOperation(async () => maybeSpawnFixSession(podId, status));
        }
      } catch (err) {
        logger.debug({ err, podId }, 'Merge polling failed, skipping cycle');
      }
    };

    // Resolve per-profile poll interval once. Falls back to the default when
    // unset; clamped at 5s by the validator so this is safe to use directly.
    let pollIntervalMs = DEFAULT_MERGE_POLL_INTERVAL_MS;
    try {
      const pod = podRepo.getOrThrow(podId);
      const profile = executionForPod(pod);
      if (profile.mergePollIntervalSec) {
        pollIntervalMs = profile.mergePollIntervalSec * 1_000;
      }
    } catch {
      // Pod or profile gone — let poll() decide what to do on its first tick.
    }

    mergePolling.start(podId, pollIntervalMs, poll);
  }

  function stopMergePolling(podId: string): void {
    mergePolling.stop(podId);
  }

  function resumeMergePolling(): void {
    const pendingSessions = podRepo.list({ status: 'merge_pending' as PodStatus });
    for (const pod of pendingSessions) {
      logger.info({ podId: pod.id, prUrl: pod.prUrl }, 'Resuming merge polling after restart');
      startMergePolling(pod.id);
    }
  }
  return { startMergePolling, stopMergePolling, resumeMergePolling };
}
