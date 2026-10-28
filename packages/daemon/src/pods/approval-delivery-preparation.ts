import path from 'node:path';
import type { Pod } from '@autopod/shared';
import { AutopodError } from '@autopod/shared';
import type { WorktreeManager } from '../interfaces/index.js';
import {
  closedPrRecoveryReason,
  inspectRetainedMergeSource,
  reconcileMerge,
} from '../worktrees/durable-merge.js';
import { publishCommittedSource, publishSource } from '../worktrees/durable-source-publication.js';
import { mergeReconciliation } from '../worktrees/merge-source-identity.js';
import type { ApprovalDeliveryPreparationCaptured } from './approval-contracts.js';
import { reconcileExternalApproval } from './approval-external-delivery.js';
import { APPROVAL_SNAPSHOT_EXCLUDES } from './approval-policy.js';
import { collectArtifactSnapshot } from './artifact-preservation.js';
import type {
  ApprovalPreparationContext,
  ApprovalPreparationResult,
} from './delivery-contracts.js';
export function createApprovalDeliveryPreparation(captured: ApprovalDeliveryPreparationCaptured) {
  const {
    podRepo,
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
  } = captured;
  async function prepareApprovalDelivery({
    podId,
    options,
    pod,
    readiness,
    actor,
    approvalReason,
  }: ApprovalPreparationContext): Promise<ApprovalPreparationResult> {
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

    // A factual, exact-source external merge is observed before any sandbox
    // wakeup. Its durable receipt pins unpreserved reports against all cleanup.
    if (
      await reconcileExternalApproval(captured, {
        podId,
        options,
        pod,
        readiness,
        actor,
        approvalReason,
      })
    )
      return { kind: 'halted' };

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
          wakeupTimeoutMs: 150_000,
          onStage: (stage) =>
            emitActivityStatus(
              podId,
              stage === 'wakeup'
                ? 'Waking retained sandbox for approval…'
                : 'Preserving workspace reports…',
            ),
        });
        assertApprovalCurrent(pod);
        podRepo.update(podId, { artifactsPath });
      } catch (error) {
        logger.error(
          { err: error, cause: error instanceof Error ? error.cause : undefined, podId },
          'Approval workspace preservation failed; resources retained',
        );
        assertApprovalCurrent(pod);
        const reason = `Approval delivery failed. ${error instanceof AutopodError && error.code === 'ARTIFACT_PRESERVATION_FAILED' ? error.message : 'Workspace preservation failed. Original resources retained; retry approval.'}`;
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
        return { kind: 'halted' };
      }
    }
    return { kind: 'ready', recoveredMerge, publishApprovalBranch, commitAndPublishApprovalBranch };
  }
  return { prepareApprovalDelivery };
}
