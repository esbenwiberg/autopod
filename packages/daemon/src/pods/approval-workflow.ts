import path from 'node:path';
import type { Pod } from '@autopod/shared';
import { AutopodError } from '@autopod/shared';
import type { PrManager, WorktreeManager } from '../interfaces/index.js';
import type { PodExecutionSettings } from '../interfaces/pod-execution-settings.js';
import {
  closedPrRecoveryReason,
  inspectRetainedMergeSource,
  mergePublishedSource,
  reconcileMerge,
} from '../worktrees/durable-merge.js';
import { publishCommittedSource, publishSource } from '../worktrees/durable-source-publication.js';
import { MergeQueue } from '../worktrees/merge-queue.js';
import { mergeReconciliation } from '../worktrees/merge-source-identity.js';
import type { ApprovalWorkflowCaptured, ApproveSessionOptions } from './approval-contracts.js';
import { APPROVAL_SNAPSHOT_EXCLUDES, assertApprovalAllowed } from './approval-policy.js';
import { collectArtifactSnapshot } from './artifact-preservation.js';
import { validateTransition } from './state-machine.js';

export function createApprovalWorkflow(captured: ApprovalWorkflowCaptured) {
  const {
    podRepo,
    resolveApprovalReadiness,
    assertApprovalCurrent,
    executionForPod,
    worktreeManager,
    emitActivityError,
    containerManagerFactory,
    logger,
    prManagerFactory,
    emitActivityStatus,
    failBranchPreservation,
    forceWithLeaseAllowances,
    transition,
    persistReadinessApproval,
    cleanupContainerAfterAdvisorySettles,
    eventBus,
    maybeTriggerDependents,
    resolveGitCredential,
    mergeQueue,
    formatRebaseConflictReason,
    startMergePolling,
    resolvePrBaseBranch,
    ensurePrBaseBranchOnOrigin,
    getLatestPushFindings,
    handleDeletionGuardError,
  } = captured;

  async function approveSession(podId: string, options: ApproveSessionOptions = {}): Promise<void> {
    const actor =
      options.actor ??
      (options.automation
        ? { type: 'automation' as const, id: 'auto-approve' }
        : { type: 'automation' as const, id: 'direct-pod-manager' });
    const pod = podRepo.getOrThrow(podId);
    validateTransition(pod.id, pod.status, 'approved');
    const readiness = await resolveApprovalReadiness(pod, { waitForAdvisory: true });
    const approvalReason = assertApprovalAllowed(podId, readiness, options);
    const isWorkspacePod = pod.options?.agentMode === 'interactive';
    const publishApprovalBranch = async (
      anchor: Pod,
      pushOptions?: { force?: boolean; pat?: string },
    ) => {
      assertApprovalCurrent(anchor);
      const ledger = podRepo.sourcePublications;
      const repository = executionForPod(anchor).repoUrl;
      if (!ledger || !repository)
        throw new AutopodError(
          'Durable source publication is unavailable; retain resources and reconcile delivery.',
          'SOURCE_PUBLICATION_RECONCILIATION_REQUIRED',
          409,
        );
      return publishSource(ledger, anchor, repository, worktreeManager, pushOptions);
    };
    const commitAndPublishApprovalBranch = (
      anchor: Pod,
      config: Parameters<WorktreeManager['mergeBranch']>[0],
    ) => {
      assertApprovalCurrent(anchor);
      const ledger = podRepo.sourcePublications;
      const repository = executionForPod(anchor).repoUrl;
      if (!ledger || !repository)
        throw new AutopodError(
          'Durable source publication is unavailable; retain resources and reconcile delivery.',
          'SOURCE_PUBLICATION_RECONCILIATION_REQUIRED',
          409,
        );
      return publishCommittedSource(ledger, anchor, repository, worktreeManager, config);
    };
    assertApprovalCurrent(pod);
    if (pod.options.output === 'pr' || pod.options.output === 'branch') {
      const missingIdentity = !pod.worktreePath?.trim()
        ? 'Worktree identity is unavailable.'
        : !pod.branch?.trim()
          ? 'Branch identity is unavailable.'
          : null;
      if (missingIdentity) {
        const reason = `Approval delivery failed. ${missingIdentity} Original resources retained; repair delivery and retry approval.`;
        podRepo.update(podId, { failureReason: reason });
        emitActivityError(podId, reason, false);
        throw new AutopodError(reason, 'DELIVERY_RECONCILIATION_REQUIRED', 409);
      }
    }

    // Git checkpoints omit ignored reports. Preserve the complete sandbox
    // workspace before publication or either approval cleanup path removes it.
    if (
      pod.executionTarget === 'sandbox' &&
      pod.containerId &&
      (pod.options.output === 'branch' || pod.options.output === 'pr')
    ) {
      const dataDir = process.env.DATA_DIR ?? path.join(process.cwd(), '.autopod-data');
      const isCurrent = () => {
        try {
          assertApprovalCurrent(pod);
          return true;
        } catch {
          return false;
        }
      };
      try {
        const artifactsPath = await collectArtifactSnapshot({
          containerManager: containerManagerFactory.get(pod.executionTarget),
          containerId: pod.containerId,
          artifactRoot: path.join(dataDir, 'artifacts', pod.id),
          generation: pod.lifecycleGeneration,
          cycle: pod.finalization?.cycle ?? 0,
          isCurrent,
          excludes: APPROVAL_SNAPSHOT_EXCLUDES,
        });
        assertApprovalCurrent(pod);
        podRepo.update(podId, { artifactsPath });
      } catch (error) {
        logger.error(
          { err: error, cause: error instanceof Error ? error.cause : undefined, podId },
          'Approval workspace preservation failed; resources retained',
        );
        assertApprovalCurrent(pod);
        const reason =
          'Approval delivery failed. Workspace reports could not be preserved. Original resources retained; repair preservation and retry approval.';
        podRepo.update(podId, { failureReason: reason });
        emitActivityError(podId, reason, false);
        throw error;
      }
    }

    let recoveredMerge = false;
    if (pod.prUrl && podRepo.mergeJournal) {
      try {
        const entry = podRepo.mergeJournal.find(pod);
        const provider = entry ? prManagerFactory?.(executionForPod(pod)) : null;
        const observedStatus =
          entry &&
          provider &&
          (entry.state === 'planned' ||
            (entry.state === 'pending' && !entry.result?.autoMergeScheduled))
            ? await provider.getPrStatus({
                prUrl: entry.request.config.prUrl,
                worktreePath: pod.worktreePath ?? undefined,
              })
            : undefined;
        assertApprovalCurrent(pod);
        if (
          entry &&
          observedStatus?.merged === false &&
          (observedStatus.open === false || entry.prDisposition === 'closed')
        ) {
          podRepo.mergeJournal.observeStatus(entry.id, observedStatus);
          if (!observedStatus.open) mergeReconciliation(closedPrRecoveryReason(entry, pod.status));
        }
        if (
          entry &&
          (observedStatus?.merged ||
            (entry.state !== 'pending' && entry.state !== 'planned') ||
            entry.result?.autoMergeScheduled)
        ) {
          if (options.squash !== undefined && entry.request.config.squash !== options.squash)
            mergeReconciliation('An earlier admitted merge uses a different method.');
          if (!provider) mergeReconciliation('The original merge provider is unavailable.');
          const result = await reconcileMerge(
            podRepo.mergeJournal,
            pod,
            entry,
            provider,
            observedStatus,
          );
          assertApprovalCurrent(pod);
          await inspectRetainedMergeSource(
            podRepo.mergeJournal,
            podRepo.sourcePublications,
            pod,
            entry,
            worktreeManager,
          );
          assertApprovalCurrent(pod);
          recoveredMerge = result.merged;
        }
      } catch (error) {
        assertApprovalCurrent(pod);
        const reason = `Approval delivery failed. ${error instanceof Error ? error.message : String(error)} Original resources retained; reconcile delivery before retrying approval.`;
        podRepo.update(podId, { failureReason: reason });
        emitActivityError(podId, reason, false);
        throw new AutopodError(reason, 'APPROVAL_DELIVERY_FAILED', 502);
      }
    }

    // No-change fast-path: skip PR creation and complete directly.
    // Workspace pods are excluded — their human edits live in the container until
    // mergeBranch() runs container→host sync-back, so they MUST take the normal
    // merge path. Re-check stats from the worktree (cached pod.filesChanged is
    // stale after force-approve / human-fix). A pod can have zero new changes
    // since startCommitSha while still carrying older work on its branch after
    // a failed/reworked run, so only suppress the branch push when the whole
    // branch is proven empty against its base.
    if (!isWorkspacePod && pod.worktreePath && !pod.prUrl) {
      assertApprovalCurrent(pod);
      let trulyNoChanges = false;
      let branchHasAccumulatedChanges: boolean | null = null;
      try {
        const profile = executionForPod(pod);
        const defaultBranch = profile.defaultBranch ?? 'main';
        const sinceCommit = pod.startCommitSha ?? undefined;
        const baseBranchForStats = pod.baseBranch ?? defaultBranch;
        const stats = await worktreeManager.getDiffStats(
          pod.worktreePath,
          baseBranchForStats,
          sinceCommit,
        );
        assertApprovalCurrent(pod);
        if (
          stats.filesChanged !== pod.filesChanged ||
          stats.linesAdded !== pod.linesAdded ||
          stats.linesRemoved !== pod.linesRemoved
        ) {
          podRepo.update(podId, {
            filesChanged: stats.filesChanged,
            linesAdded: stats.linesAdded,
            linesRemoved: stats.linesRemoved,
          });
        }
        trulyNoChanges = stats.filesChanged === 0;
        if (trulyNoChanges && worktreeManager.hasChangesAgainstBase) {
          try {
            branchHasAccumulatedChanges = await worktreeManager.hasChangesAgainstBase(
              pod.worktreePath,
              baseBranchForStats,
            );
          } catch (err) {
            logger.warn(
              { err, podId, baseBranch: baseBranchForStats },
              'Failed to prove no-change branch is empty; preserving branch push',
            );
          }
        }
      } catch (err) {
        assertApprovalCurrent(pod);
        logger.warn(
          { err, podId },
          'getDiffStats failed in approveSession; falling back to normal merge path',
        );
        trulyNoChanges = false;
      }

      assertApprovalCurrent(pod);
      if (trulyNoChanges) {
        const shouldPushBranch = branchHasAccumulatedChanges !== false;
        emitActivityStatus(
          podId,
          shouldPushBranch
            ? 'No new changes to merge — pushing existing branch and completing pod'
            : 'No changes to merge — completing without branch push',
        );
        if (shouldPushBranch) {
          if (!pod.branch) failBranchPreservation(pod);
          try {
            const useForce = forceWithLeaseAllowances.has(podId);
            if (useForce) {
              await publishApprovalBranch(pod, { force: true });
            } else {
              await publishApprovalBranch(pod);
            }
          } catch (err) {
            logger.warn(
              { err, podId },
              'Branch preservation failed in no-changes approval; retaining resources',
            );
            failBranchPreservation(pod);
          }
          assertApprovalCurrent(pod);
          forceWithLeaseAllowances.delete(podId);
        } else {
          forceWithLeaseAllowances.delete(podId);
        }
        // transition publishes status synchronously and returns the current row.
        // A listener can replace that row; retain the original approval identity.
        const approvedAnchor: Pod = { ...pod, status: 'approved' };
        const mergingAnchor: Pod = { ...pod, status: 'merging' };
        const s1 = transition(pod, 'approved');
        assertApprovalCurrent(approvedAnchor);
        persistReadinessApproval(podId, readiness, actor, approvalReason);
        assertApprovalCurrent(approvedAnchor);
        const s2 = transition(s1, 'merging');
        assertApprovalCurrent(mergingAnchor);
        await cleanupContainerAfterAdvisorySettles(s2, 'approve-no-changes', 'kill', () =>
          assertApprovalCurrent(mergingAnchor, {
            allowRemovedContainer: true,
            allowComplete: true,
          }),
        );
        assertApprovalCurrent(mergingAnchor, { allowRemovedContainer: true });
        const noChangePod = transition(s2, 'complete', {
          completedAt: new Date().toISOString(),
          ...(pod.failureReason?.startsWith('Branch preservation failed.') ||
          pod.failureReason?.startsWith('Approval delivery failed.')
            ? { failureReason: null }
            : {}),
        });
        assertApprovalCurrent({ ...pod, status: 'complete' }, { allowRemovedContainer: true });
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
            filesChanged: 0,
            createdAt: pod.createdAt,
          },
        });
        logger.info(
          { podId, branchPushed: shouldPushBranch },
          'Pod approved with no changes — completed without PR',
        );
        assertApprovalCurrent({ ...pod, status: 'complete' }, { allowRemovedContainer: true });
        maybeTriggerDependents(noChangePod);
        return;
      }
    }

    assertApprovalCurrent(pod);
    emitActivityStatus(podId, 'Approved — merging changes…');
    assertApprovalCurrent(pod);
    const approvedAnchor: Pod = { ...pod, status: 'approved' };
    const mergingAnchor: Pod = { ...pod, status: 'merging' };
    const s1 = transition(pod, 'approved');
    assertApprovalCurrent(approvedAnchor);
    persistReadinessApproval(podId, readiness, actor, approvalReason);
    assertApprovalCurrent(approvedAnchor);
    const s2 = transition(s1, 'merging');
    assertApprovalCurrent(mergingAnchor);

    // Keep the captured generation across waits, including rejected operations.
    // A stale callback must not enter a recovery catch for a replacement pod.
    const deliveryOperation = async <T>(operation: () => Promise<T>): Promise<T> => {
      assertApprovalCurrent(mergingAnchor);
      try {
        return await operation();
      } finally {
        assertApprovalCurrent(mergingAnchor);
      }
    };
    const deliveryCredential = (profile: PodExecutionSettings) =>
      deliveryOperation(() => resolveGitCredential(profile));
    const failDelivery = (detail: string): never => {
      assertApprovalCurrent(mergingAnchor);
      const reason = `Approval delivery failed. ${detail} Original resources retained; repair delivery and retry approval.`;
      transition(mergingAnchor, 'validated', { failureReason: reason });
      assertApprovalCurrent({ ...pod, status: 'validated' });
      emitActivityError(podId, reason, false);
      throw new AutopodError(reason, 'APPROVAL_DELIVERY_FAILED', 502);
    };

    // Merge the PR if one was created, otherwise fall back to branch push
    const approveProfile = executionForPod(pod);
    const prManager = prManagerFactory ? prManagerFactory(approveProfile) : null;
    const mergeApprovalSource = (
      publication: Awaited<ReturnType<typeof publishApprovalBranch>>,
      provider: PrManager,
      config: Parameters<PrManager['mergePr']>[0],
    ) => {
      if (!podRepo.mergeJournal) mergeReconciliation('Durable merge admission is unavailable.');
      return mergePublishedSource(
        podRepo.mergeJournal,
        podRepo.getOrThrow(podId),
        mergingAnchor,
        publication,
        provider,
        config,
      );
    };
    const planApprovalSource = (
      publication: Awaited<ReturnType<typeof publishApprovalBranch>>,
      prUrl: string,
      baseBranch: string,
    ) => {
      assertApprovalCurrent(mergingAnchor);
      if (!podRepo.mergeJournal) mergeReconciliation('Durable merge planning is unavailable.');
      return podRepo.mergeJournal.plan(
        podRepo.getOrThrow(podId),
        mergingAnchor,
        publication.publicationId,
        {
          prUrl,
          expectedHeadSha: publication.commitSha,
          expectedTarget: {
            repository: publication.repository,
            branch: publication.branch,
            baseBranch,
          },
          squash: options.squash,
        },
      );
    };
    if (recoveredMerge) {
      emitActivityStatus(podId, 'Earlier merge confirmed from durable source and target evidence');
    } else if (pod.prUrl && prManager && pod.worktreePath) {
      const mergeBaseBranch = pod.baseBranch ?? approveProfile.defaultBranch ?? 'main';
      const queueKey = MergeQueue.keyFor(approveProfile.repoUrl, mergeBaseBranch);
      const worktreePath = pod.worktreePath;
      const prUrl = pod.prUrl;

      try {
        const initialStatus = await deliveryOperation(() =>
          prManager.getPrStatus({ prUrl, worktreePath }),
        );
        if (initialStatus.merged || !initialStatus.open)
          failDelivery(
            'The PR has an external disposition without a confirmed daemon merge. Reconcile it before publishing retained source.',
          );
      } catch (error) {
        // failDelivery already moved the original lifecycle back to validated.
        if (error instanceof AutopodError && error.code === 'APPROVAL_DELIVERY_FAILED') throw error;
        assertApprovalCurrent(mergingAnchor);
        failDelivery('The current PR disposition is unavailable.');
      }

      // Outcome of the queued critical section. We do state transitions outside
      // the queue so the lock is released as quickly as possible.
      type MergeOutcome =
        | { kind: 'merged' }
        | { kind: 'merge_pending'; blockReason: string }
        | { kind: 'merge_failed'; reason: string };

      const outcome = await mergeQueue
        .run<MergeOutcome>(queueKey, async () => {
          assertApprovalCurrent(mergingAnchor);
          // Fix pods make commits in the container but rely on the agent to push.
          // Push explicitly here before attempting to complete the PR so any local
          // commits the agent forgot (or failed) to push are flushed to the remote.
          // Pass the PAT so we don't depend on the in-memory cache, which is
          // evicted whenever any sibling worktree on the same bare repo is
          // cleaned up (local-worktree-manager.ts cleanup()).
          let publishedSource: Awaited<ReturnType<typeof publishApprovalBranch>>;
          const useForce = forceWithLeaseAllowances.has(podId);
          try {
            publishedSource = await deliveryOperation(async () =>
              publishApprovalBranch(mergingAnchor, {
                pat: await deliveryCredential(approveProfile),
                ...(useForce ? { force: true } : {}),
              }),
            );
            forceWithLeaseAllowances.delete(podId);
            emitActivityStatus(podId, 'Branch pushed');
          } catch (pushErr) {
            assertApprovalCurrent(mergingAnchor);
            const reason = pushErr instanceof Error ? pushErr.message : String(pushErr);
            const blockReason = `Push to origin failed: ${reason}`;
            logger.warn(
              { err: pushErr, podId },
              'Pre-merge push failed — retaining source for explicit approval retry',
            );
            return { kind: 'merge_failed', reason: blockReason };
          }

          // Pre-merge rebase onto latest origin/<base>. Catches conflicts
          // *before* the PR merge attempt so an agent (or fix pod) gets to
          // resolve them while it still has full task context, instead of
          // discovering the conflict via GitHub's merge gate after the fact.
          // Runs inside the merge queue so the rebase always sees the freshly
          // merged state of any preceding pod on the same base.
          emitActivityStatus(podId, `Rebasing onto origin/${mergeBaseBranch}…`);
          const rebaseResult = await deliveryOperation(async () =>
            worktreeManager.rebaseOntoBase({
              worktreePath,
              baseBranch: mergeBaseBranch,
              pat: await deliveryCredential(approveProfile),
            }),
          );

          if (!rebaseResult.rebased) {
            const blockReason = formatRebaseConflictReason(mergeBaseBranch, rebaseResult.conflicts);
            logger.info(
              {
                podId,
                prUrl,
                baseBranch: mergeBaseBranch,
                conflicts: rebaseResult.conflicts,
              },
              'Pre-merge rebase produced conflicts — retaining source for manual resolution',
            );
            return { kind: 'merge_failed', reason: blockReason };
          }

          // Rebase rewrote history → force-push so origin/<branch> matches our
          // new HEAD. Skip the push when the rebase was a no-op (already up to
          // date) since we already pushed above.
          if (!rebaseResult.alreadyUpToDate) {
            try {
              publishedSource = await deliveryOperation(async () =>
                publishApprovalBranch(mergingAnchor, {
                  force: true,
                  pat: await deliveryCredential(approveProfile),
                }),
              );
              emitActivityStatus(podId, 'Rebased branch pushed');
            } catch (pushErr) {
              assertApprovalCurrent(mergingAnchor);
              const reason = pushErr instanceof Error ? pushErr.message : String(pushErr);
              const blockReason = `Force-push after rebase failed: ${reason}`;
              logger.warn(
                { err: pushErr, podId },
                'Force-push after rebase failed — retaining source for explicit approval retry',
              );
              return { kind: 'merge_failed', reason: blockReason };
            }
          }

          planApprovalSource(publishedSource, prUrl, mergeBaseBranch);

          // Daemon-side approval gate: check the PR's review decision before attempting
          // to merge. If the platform reports that a review is still required or changes
          // were requested, enter merge_pending and let the poller wait for approval.
          // This ensures the daemon never bypasses required review gates even when
          // GitHub auto-merge is enabled.
          try {
            const prStatus = await deliveryOperation(async () =>
              prManager.getPrStatus({ prUrl, worktreePath }),
            );
            if (prStatus.merged || !prStatus.open)
              return {
                kind: 'merge_failed',
                reason:
                  'The PR changed external disposition before merge admission; reconcile the retained source.',
              };
            if (prStatus.reviewDecision && prStatus.reviewDecision !== 'APPROVED') {
              const blockReason = `Waiting for PR review approval (current decision: ${prStatus.reviewDecision})`;
              logger.info(
                { podId, prUrl, reviewDecision: prStatus.reviewDecision },
                'Merge deferred — PR requires explicit approval before daemon will merge',
              );
              return { kind: 'merge_pending', blockReason };
            }
          } catch (statusErr) {
            assertApprovalCurrent(mergingAnchor);
            // Unknown review evidence cannot authorize a merge.
            logger.warn(
              { err: statusErr, podId, prUrl },
              'Failed to check PR review decision before merge — retaining resources',
            );
            return { kind: 'merge_failed', reason: 'PR review status is unavailable.' };
          }

          emitActivityStatus(podId, `Merging PR: ${prUrl}`);
          try {
            const mergeResult = await deliveryOperation(async () =>
              mergeApprovalSource(publishedSource, prManager, {
                onPrepared: () => assertApprovalCurrent(mergingAnchor),
                expectedHeadSha: publishedSource.commitSha,
                expectedTarget: {
                  repository: publishedSource.repository,
                  branch: publishedSource.branch,
                  baseBranch: mergeBaseBranch,
                },
                worktreePath,
                prUrl,
                squash: options?.squash,
              }),
            );

            if (mergeResult.merged) {
              return { kind: 'merged' };
            }
            // Merge didn't complete immediately — enter merge_pending state
            const initialStatus = await deliveryOperation(async () =>
              prManager.getPrStatus({ prUrl, worktreePath }),
            );
            const blockReason = initialStatus.blockReason ?? 'Waiting for merge conditions';
            logger.info(
              {
                podId,
                prUrl,
                blockReason,
                autoMerge: mergeResult.autoMergeScheduled,
              },
              'Pod approved — merge pending',
            );
            return { kind: 'merge_pending', blockReason };
          } catch (err) {
            assertApprovalCurrent(mergingAnchor);
            logger.error({ err, podId, prUrl }, 'Failed to merge PR');
            return { kind: 'merge_failed', reason: 'PR merge could not be confirmed.' };
          }
        })
        .catch((err): MergeOutcome => {
          assertApprovalCurrent(mergingAnchor);
          logger.error({ err, podId }, 'Approval delivery operation failed; retaining resources');
          return { kind: 'merge_failed', reason: 'PR preparation did not complete.' };
        });

      assertApprovalCurrent(mergingAnchor);
      if (outcome.kind === 'merged') {
        emitActivityStatus(podId, 'PR merged successfully');
      } else if (outcome.kind === 'merge_pending') {
        emitActivityStatus(podId, `Merge pending: ${outcome.blockReason}`);
        assertApprovalCurrent(mergingAnchor);
        transition(s2, 'merge_pending', { mergeBlockReason: outcome.blockReason });
        assertApprovalCurrent({ ...pod, status: 'merge_pending' });
        startMergePolling(podId);
        return;
      } else {
        failDelivery(outcome.reason);
      }
    } else if (!pod.prUrl && prManager && pod.worktreePath && pod.options.output === 'pr') {
      // PR creation failed during validation — retry it now
      emitActivityStatus(podId, 'No PR found — creating PR before merging…');
      let retryPrUrl: string | null = null;
      try {
        const retryProfile = executionForPod(pod);
        const publishedSource = await deliveryOperation(async () =>
          commitAndPublishApprovalBranch(mergingAnchor, {
            worktreePath: pod.worktreePath,
            // Push the feature branch up so the PR can be opened against the resolved base.
            targetBranch: pod.branch,
            // Pass the PAT explicitly — approval retry runs post-container, so the
            // in-memory PAT cache may be cold after a daemon restart.
            pat: await deliveryCredential(retryProfile),
            // Post-container retry: sync-back already happened (or failed silently) upstream;
            // belt-and-suspenders autocommit here must not commit a phantom mass-deletion.
            maxDeletions: 0,
            // Provide pod task as context for any auto-generated commit message.
            podTask: pod.task,
            profile: retryProfile,
            podModel: pod.model,
          }),
        );
        const baseBranch = resolvePrBaseBranch(pod, retryProfile);
        await deliveryOperation(async () =>
          ensurePrBaseBranchOnOrigin(pod, retryProfile, baseBranch, 'approval_retry'),
        );
        const createResult = await deliveryOperation(async () =>
          prManager.createPr({
            // biome-ignore lint/style/noNonNullAssertion: worktreePath is non-null in approval retry — pods reach approved only after successful validation which requires a worktree
            worktreePath: pod.worktreePath!,
            repoUrl: retryProfile.repoUrl ?? undefined,
            branch: pod.branch,
            baseBranch,
            podId,
            task: pod.task,
            profileName: pod.profileName,
            profile: retryProfile,
            podModel: pod.model,
            handoffInstructions: pod.handoffInstructions ?? undefined,
            validationResult: null,
            validationWaiver: pod.validationWaiver,
            filesChanged: pod.filesChanged,
            linesAdded: pod.linesAdded,
            linesRemoved: pod.linesRemoved,
            previewUrl: pod.previewUrl,
            screenshots: [],
            taskSummary: pod.taskSummary ?? undefined,
            seriesDescription: pod.seriesDescription ?? undefined,
            seriesName: pod.seriesName ?? undefined,
            securityFindings: getLatestPushFindings(podId),
          }),
        );
        const newPrUrl = createResult.url;
        retryPrUrl = newPrUrl;
        if (createResult.usedFallback) {
          const which = createResult.narrativeUsedFallback
            ? createResult.titleUsedFallback
              ? 'title + body'
              : 'body'
            : 'title';
          const reason = createResult.fallbackReason ?? 'unknown';
          logger.error(
            {
              podId,
              profile: retryProfile.name,
              modelProvider: retryProfile.modelProvider,
              fallbackReason: reason,
              fallbackDetail: createResult.fallbackDetail,
            },
            'PR description used template fallback during approval retry',
          );
          emitActivityStatus(podId, `PR ${which} used template fallback: ${reason}`);
        }
        assertApprovalCurrent(mergingAnchor);
        podRepo.update(podId, { prUrl: newPrUrl });
        emitActivityStatus(podId, `PR created: ${newPrUrl}`);
        planApprovalSource(publishedSource, newPrUrl, baseBranch);
        const reviewStatus = await deliveryOperation(async () =>
          prManager.getPrStatus({ prUrl: newPrUrl, worktreePath: pod.worktreePath }),
        );
        if (reviewStatus.merged || !reviewStatus.open)
          mergeReconciliation(
            'The PR has an external disposition without a recorded daemon merge.',
          );
        if (reviewStatus.reviewDecision && reviewStatus.reviewDecision !== 'APPROVED') {
          const blockReason = `Waiting for PR review approval (current decision: ${reviewStatus.reviewDecision})`;
          transition(s2, 'merge_pending', { mergeBlockReason: blockReason });
          assertApprovalCurrent({ ...pod, status: 'merge_pending' });
          startMergePolling(podId);
          return;
        }
        const retryMergeResult = await deliveryOperation(async () =>
          mergeApprovalSource(publishedSource, prManager, {
            onPrepared: () => assertApprovalCurrent(mergingAnchor),
            expectedHeadSha: publishedSource.commitSha,
            expectedTarget: {
              repository: publishedSource.repository,
              branch: publishedSource.branch,
              baseBranch,
            },
            worktreePath: pod.worktreePath,
            prUrl: newPrUrl,
            squash: options?.squash,
          }),
        );
        if (retryMergeResult.merged) {
          emitActivityStatus(podId, 'PR merged successfully');
        } else {
          const retryStatus = await deliveryOperation(async () =>
            prManager.getPrStatus({
              prUrl: newPrUrl,
              worktreePath: pod.worktreePath,
            }),
          );
          const blockReason = retryStatus.blockReason ?? 'Waiting for merge conditions';
          emitActivityStatus(podId, `Merge pending: ${blockReason}`);
          assertApprovalCurrent(mergingAnchor);
          transition(s2, 'merge_pending', { mergeBlockReason: blockReason });
          assertApprovalCurrent({ ...pod, status: 'merge_pending' });
          startMergePolling(podId);
          return;
        }
      } catch (err) {
        assertApprovalCurrent(mergingAnchor);
        logger.error({ err, podId }, 'Failed to create/merge PR during approval');
        if (handleDeletionGuardError(podId, err)) {
          failDelivery('Source synchronization was rejected by the deletion guard.');
        }
        const message = err instanceof Error ? err.message : String(err);
        if (retryPrUrl) failDelivery(`Merge after PR creation could not be confirmed: ${message}`);
        emitActivityStatus(podId, `PR creation failed: ${message} — pod returned to validated`);
        failDelivery('PR creation did not complete.');
      }
    } else if (pod.worktreePath) {
      // Fallback: no PR manager configured — push branch directly
      emitActivityStatus(podId, 'Pushing branch…');
      try {
        const profile = executionForPod(pod);
        await deliveryOperation(async () =>
          commitAndPublishApprovalBranch(mergingAnchor, {
            worktreePath: pod.worktreePath,
            // Push the feature branch up to origin — no PR manager configured, so this is the
            // last step. Pushing onto profile.defaultBranch would force-push the feature work
            // straight onto main, which is never what we want.
            targetBranch: pod.branch,
            // Pass the PAT explicitly — fallback push runs post-container, so the
            // in-memory PAT cache may be cold after a daemon restart.
            pat: await deliveryCredential(profile),
            // Post-container fallback push: don't let a stale worktree commit a phantom mass-delete.
            maxDeletions: 0,
            podTask: pod.task,
            profile,
            podModel: pod.model,
          }),
        );
        emitActivityStatus(podId, 'Branch pushed successfully');
      } catch (err) {
        assertApprovalCurrent(mergingAnchor);
        logger.error({ err, podId }, 'Failed to push branch during approval');
        if (!handleDeletionGuardError(podId, err)) {
          const message = err instanceof Error ? err.message : String(err);
          emitActivityStatus(podId, `Branch push failed: ${message} — resources retained`);
        }
        failDelivery('Branch push did not complete.');
      }
    }

    assertApprovalCurrent(mergingAnchor);
    await cleanupContainerAfterAdvisorySettles(s2, 'approve-complete', 'kill', () =>
      assertApprovalCurrent(mergingAnchor, { allowRemovedContainer: true, allowComplete: true }),
    );
    assertApprovalCurrent(mergingAnchor, { allowRemovedContainer: true });
    const completedPod = transition(s2, 'complete', {
      completedAt: new Date().toISOString(),
      ...(pod.failureReason?.startsWith('Approval delivery failed.')
        ? { failureReason: null }
        : {}),
    });
    assertApprovalCurrent({ ...pod, status: 'complete' }, { allowRemovedContainer: true });

    emitActivityStatus(podId, 'Pod complete');
    assertApprovalCurrent({ ...pod, status: 'complete' }, { allowRemovedContainer: true });
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

    logger.info({ podId, prUrl: pod.prUrl }, 'Pod approved and completed');
    assertApprovalCurrent({ ...pod, status: 'complete' }, { allowRemovedContainer: true });
    maybeTriggerDependents(completedPod);
  }
  return { approveSession };
}
