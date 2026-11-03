import { AutopodError } from '@autopod/shared';
import type { PrManager } from '../interfaces/index.js';
import type { PodExecutionSettings } from '../interfaces/pod-execution-settings.js';
import { mergePublishedSource } from '../worktrees/durable-merge.js';
import { MergeQueue } from '../worktrees/merge-queue.js';
import { assertMergeRepository, mergeReconciliation } from '../worktrees/merge-source-identity.js';
import type { ApprovalDeliveryExecutionCaptured } from './approval-contracts.js';
import { activateApprovalRewrite, prepareApprovalRewrite } from './approval-source-rewrite.js';
import type { ApprovalExecutionContext, DeliveryStageResult } from './delivery-contracts.js';
export function createApprovalDeliveryExecution(captured: ApprovalDeliveryExecutionCaptured) {
  const {
    podRepo,
    assertApprovalCurrent,
    executionForPod,
    emitActivityError,
    logger,
    prManagerFactory,
    emitActivityStatus,
    transition,
    resolveGitCredential,
    mergeQueue,
    startMergePolling,
    resolvePrBaseBranch,
    ensurePrBaseBranchOnOrigin,
    getLatestPushFindings,
    handleDeletionGuardError,
  } = captured;
  async function executeApprovalDelivery({
    podId,
    options,
    pod,
    mergingAnchor,
    s2,
    recoveredMerge,
    publishApprovalBranch,
    commitAndPublishApprovalBranch,
  }: ApprovalExecutionContext): Promise<DeliveryStageResult> {
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
    const failDelivery = (detail: string, cause?: unknown): never => {
      assertApprovalCurrent(mergingAnchor);
      const reconciliation =
        cause instanceof AutopodError &&
        ['DELIVERY_RECONCILIATION_REQUIRED', 'SOURCE_PUBLICATION_RECONCILIATION_REQUIRED'].includes(
          cause.code,
        );
      const advice = reconciliation
        ? 'reconcile delivery before retrying approval'
        : 'repair delivery and retry approval';
      const reason = `Approval delivery failed. ${detail} Original resources retained; ${advice}.`;
      if (options.publishOnly) podRepo.update(podId, { failureReason: reason });
      else transition(mergingAnchor, 'validated', { failureReason: reason });
      assertApprovalCurrent({ ...pod, status: 'validated' });
      emitActivityError(podId, reason, false);
      if (reconciliation) throw new AutopodError(reason, 'DELIVERY_RECONCILIATION_REQUIRED', 409);
      throw new AutopodError(reason, 'APPROVAL_DELIVERY_FAILED', 502);
    };

    // Merge the PR if one was created, otherwise fall back to branch push
    const approveProfile = executionForPod(pod);
    const prManager = prManagerFactory ? prManagerFactory(approveProfile) : null;
    if (options.publishOnly && !prManager)
      failDelivery('PR-only publication requires a configured PR provider.');
    const assertPublishedPr = (
      status: Awaited<ReturnType<PrManager['getPrStatus']>>,
      baseBranch: string,
      expectedHead?: string,
    ) => {
      const target = status.sourceTarget;
      if (
        !status.open ||
        status.merged ||
        !target ||
        target.branch !== pod.branch ||
        target.baseBranch !== baseBranch ||
        (expectedHead !== undefined && status.headSha !== expectedHead)
      )
        throw new AutopodError(
          'Current PR source/target does not confirm this publication; retain resources and reconcile',
          'DELIVERY_RECONCILIATION_REQUIRED',
          409,
        );
      assertMergeRepository(
        { repository: approveProfile.repoUrl ?? '', branch: pod.branch, baseBranch },
        target.repository,
      );
    };
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
    let mergeSquash = options.squash;
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
          squash: mergeSquash,
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
        if (options.publishOnly) assertPublishedPr(initialStatus, mergeBaseBranch);
        if (initialStatus.merged || !initialStatus.open)
          failDelivery(
            'The PR has an external disposition without a confirmed daemon merge. Reconcile it before publishing retained source.',
          );
      } catch (error) {
        // failDelivery already moved the original lifecycle back to validated.
        if (error instanceof AutopodError && error.code === 'APPROVAL_DELIVERY_FAILED') throw error;
        assertApprovalCurrent(mergingAnchor);
        failDelivery('The current PR disposition or source binding is unavailable.', error);
      }

      // Outcome of the queued critical section. We do state transitions outside
      // the queue so the lock is released as quickly as possible.
      type MergeOutcome =
        | { kind: 'merged' }
        | { kind: 'published' }
        | { kind: 'revalidate'; rewriteId: string }
        | { kind: 'merge_pending'; blockReason: string }
        | { kind: 'merge_failed'; reason: string; cause?: unknown };

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
          try {
            publishedSource = await deliveryOperation(async () =>
              publishApprovalBranch(mergingAnchor, {
                pat: await deliveryCredential(approveProfile),
              }),
            );
            emitActivityStatus(podId, 'Branch pushed');
          } catch (pushErr) {
            assertApprovalCurrent(mergingAnchor);
            const reason = pushErr instanceof Error ? pushErr.message : String(pushErr);
            const blockReason = `Push to origin failed: ${reason}`;
            logger.warn(
              { err: pushErr, podId },
              'Pre-merge push failed — retaining source for explicit approval retry',
            );
            return { kind: 'merge_failed', reason: blockReason, cause: pushErr };
          }

          if (options.publishOnly) {
            const status = await deliveryOperation(() =>
              prManager.getPrStatus({ prUrl, worktreePath }),
            );
            assertPublishedPr(status, mergeBaseBranch, publishedSource.commitSha);
            return { kind: 'published' };
          }

          // Never rewrite the approved worktree or publish untested rebased code.
          // The isolated candidate is durably selected for checks-only provisioning;
          // successful checks require a new approval before its exact leased push.
          emitActivityStatus(podId, `Checking latest origin/${mergeBaseBranch}…`);
          const rewriteId = await prepareApprovalRewrite(
            captured,
            mergingAnchor,
            publishedSource,
            mergeBaseBranch,
            await deliveryCredential(approveProfile),
          );
          if (rewriteId) return { kind: 'revalidate', rewriteId };

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
            if (prStatus.squashRequired && mergeSquash === undefined) mergeSquash = true;
            planApprovalSource(publishedSource, prUrl, mergeBaseBranch);
            if (prStatus.squashRequired && mergeSquash !== true) {
              return { kind: 'merge_pending', blockReason: 'Branch policy requires squash merge' };
            }
            if (prStatus.mergeBlocked || prStatus.ciFailures.length > 0) {
              return {
                kind: 'merge_pending',
                blockReason: prStatus.blockReason ?? 'Waiting for required CI checks',
              };
            }
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
            return {
              kind: 'merge_failed',
              reason: 'PR review status is unavailable.',
              cause: statusErr,
            };
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
                squash: mergeSquash,
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
            return {
              kind: 'merge_failed',
              reason:
                err instanceof AutopodError && err.code === 'DELIVERY_RECONCILIATION_REQUIRED'
                  ? err.message
                  : 'PR merge could not be confirmed.',
              cause: err,
            };
          }
        })
        .catch((err): MergeOutcome => {
          assertApprovalCurrent(mergingAnchor);
          logger.error({ err, podId }, 'Approval delivery operation failed; retaining resources');
          return {
            kind: 'merge_failed',
            reason:
              err instanceof AutopodError && err.code === 'DELIVERY_RECONCILIATION_REQUIRED'
                ? err.message
                : 'PR preparation did not complete.',
            cause: err,
          };
        });

      assertApprovalCurrent(mergingAnchor);
      if (outcome.kind === 'published') {
        emitActivityStatus(
          podId,
          'PR source updated for review; no merge, polling, completion or cleanup authorized',
        );
        return { kind: 'halted' };
      }
      if (outcome.kind === 'revalidate') {
        activateApprovalRewrite(captured, mergingAnchor, outcome.rewriteId);
        return { kind: 'halted' };
      }
      if (outcome.kind === 'merged') {
        emitActivityStatus(podId, 'PR merged successfully');
      } else if (outcome.kind === 'merge_pending') {
        emitActivityStatus(podId, `Merge pending: ${outcome.blockReason}`);
        assertApprovalCurrent(mergingAnchor);
        transition(s2, 'merge_pending', { mergeBlockReason: outcome.blockReason });
        assertApprovalCurrent({ ...pod, status: 'merge_pending' });
        startMergePolling(podId);
        return { kind: 'halted' };
      } else {
        failDelivery(outcome.reason, outcome.cause);
      }
    } else if (!pod.prUrl && prManager && pod.worktreePath && pod.options.output === 'pr') {
      // PR creation failed during validation — retry it now
      emitActivityStatus(
        podId,
        options.publishOnly
          ? 'Publishing a PR for review only…'
          : 'No PR found — creating PR before merging…',
      );
      let retryPrUrl: string | null = null;
      const retryWorktreePath = pod.worktreePath;
      try {
        const retryProfile = executionForPod(pod);
        const publishedSource = await deliveryOperation(async () =>
          options.publishOnly
            ? publishApprovalBranch(mergingAnchor, { pat: await deliveryCredential(retryProfile) })
            : commitAndPublishApprovalBranch(mergingAnchor, {
                worktreePath: retryWorktreePath,
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
            validationResult: options.publishOnly ? pod.lastValidationResult : null,
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
        const reviewStatus = await deliveryOperation(async () =>
          prManager.getPrStatus({ prUrl: newPrUrl, worktreePath: retryWorktreePath }),
        );
        if (reviewStatus.merged || !reviewStatus.open)
          mergeReconciliation(
            'The PR has an external disposition without a recorded daemon merge.',
          );
        if (options.publishOnly) {
          assertPublishedPr(reviewStatus, baseBranch, publishedSource.commitSha);
          emitActivityStatus(
            podId,
            'PR published for review; no merge, polling, completion or cleanup authorized',
          );
          return { kind: 'halted' };
        }
        if (reviewStatus.squashRequired && mergeSquash === undefined) mergeSquash = true;
        planApprovalSource(publishedSource, newPrUrl, baseBranch);
        if (
          (reviewStatus.squashRequired && mergeSquash !== true) ||
          reviewStatus.mergeBlocked ||
          reviewStatus.ciFailures.length > 0 ||
          (reviewStatus.reviewDecision && reviewStatus.reviewDecision !== 'APPROVED')
        ) {
          const blockReason =
            reviewStatus.squashRequired && mergeSquash !== true
              ? 'Branch policy requires squash merge'
              : (reviewStatus.blockReason ?? 'Waiting for PR merge conditions');
          transition(s2, 'merge_pending', { mergeBlockReason: blockReason });
          assertApprovalCurrent({ ...pod, status: 'merge_pending' });
          startMergePolling(podId);
          return { kind: 'halted' };
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
            worktreePath: retryWorktreePath,
            prUrl: newPrUrl,
            squash: mergeSquash,
          }),
        );
        if (retryMergeResult.merged) {
          emitActivityStatus(podId, 'PR merged successfully');
        } else {
          const retryStatus = await deliveryOperation(async () =>
            prManager.getPrStatus({
              prUrl: newPrUrl,
              worktreePath: retryWorktreePath,
            }),
          );
          const blockReason = retryStatus.blockReason ?? 'Waiting for merge conditions';
          emitActivityStatus(podId, `Merge pending: ${blockReason}`);
          assertApprovalCurrent(mergingAnchor);
          transition(s2, 'merge_pending', { mergeBlockReason: blockReason });
          assertApprovalCurrent({ ...pod, status: 'merge_pending' });
          startMergePolling(podId);
          return { kind: 'halted' };
        }
      } catch (err) {
        assertApprovalCurrent(mergingAnchor);
        logger.error({ err, podId }, 'Failed to create/merge PR during approval');
        if (handleDeletionGuardError(podId, err)) {
          failDelivery('Source synchronization was rejected by the deletion guard.');
        }
        const message = err instanceof Error ? err.message : String(err);
        if (retryPrUrl)
          failDelivery(
            `${options.publishOnly ? 'PR publication' : 'Merge after PR creation'} could not be confirmed: ${message}`,
            err,
          );
        emitActivityStatus(podId, `PR creation failed: ${message} — pod returned to validated`);
        failDelivery('PR creation did not complete.');
      }
    } else if (pod.worktreePath) {
      const fallbackWorktreePath = pod.worktreePath;
      // Fallback: no PR manager configured — push branch directly
      emitActivityStatus(podId, 'Pushing branch…');
      try {
        const profile = executionForPod(pod);
        await deliveryOperation(async () =>
          commitAndPublishApprovalBranch(mergingAnchor, {
            worktreePath: fallbackWorktreePath,
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
    return { kind: 'ready' };
  }
  return { executeApprovalDelivery };
}
