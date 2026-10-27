import type { Pod } from '@autopod/shared';
import {
  assertFixPublicationAllowed,
  publishFixSource,
} from '../worktrees/fix-source-publication.js';
import { mergeReconciliation } from '../worktrees/merge-source-identity.js';
import { formatRebaseConflictReason } from './delivery-policy.js';
import type { FixDeliveryCaptured } from './fix-contracts.js';
import { isTerminalState } from './state-machine.js';
export function createFixDelivery(captured: FixDeliveryCaptured) {
  const {
    assertGuidanceCollected,
    executionForPod,
    podRepo,
    logger,
    emitActivityStatus,
    mergeQueue,
    worktreeManager,
    resolveGitCredential,
    parkFixPodDeliveryFailure,
    postFixPodReviewFeedbackReplies,
    cleanupContainer,
    transition,
    eventBus,
  } = captured;
  async function completeFixPodAfterPush(fixPod: Pod): Promise<void> {
    assertGuidanceCollected(fixPod.id);
    const podId = fixPod.id;
    const profile = executionForPod(fixPod);
    const baseBranch = fixPod.baseBranch ?? profile.defaultBranch ?? 'main';
    const branch = fixPod.branch ?? '';
    const worktreePath = fixPod.worktreePath;
    let branchPushed = false;
    const linkedParentIsTerminal = () =>
      fixPod.linkedPodId !== null && isTerminalState(podRepo.getOrThrow(fixPod.linkedPodId).status);

    if (linkedParentIsTerminal()) {
      logger.info(
        { podId, parentId: fixPod.linkedPodId },
        'Skipping fix-pod delivery because linked parent is already terminal',
      );
      emitActivityStatus(podId, 'Linked parent is already complete; skipping branch delivery');
    } else if (worktreePath && branch) {
      try {
        await mergeQueue.enqueueMerge(profile.repoUrl ?? null, baseBranch, async () => {
          if (linkedParentIsTerminal()) {
            logger.info(
              { podId, parentId: fixPod.linkedPodId },
              'Skipping queued fix-pod delivery because linked parent became terminal',
            );
            return;
          }

          const parent = fixPod.linkedPodId ? podRepo.getOrThrow(fixPod.linkedPodId) : null;
          const journal = podRepo.mergeJournal;
          const entry = parent && journal?.find(parent);
          if (!parent || !journal || !entry || !profile.repoUrl)
            return mergeReconciliation(
              'The parent delivery history is unavailable for fix publication.',
            );
          assertFixPublicationAllowed(journal, parent, entry);
          const handoff = podRepo.sourcePublications?.fixForMerge(parent);
          if (handoff && handoff.publicationId !== entry.publicationId)
            return mergeReconciliation(
              'The previous fix publication must be reconciled before another rebase.',
            );

          emitActivityStatus(podId, `Rebasing onto origin/${baseBranch}…`);
          const rebaseResult = await worktreeManager.rebaseOntoBase({
            worktreePath,
            baseBranch,
            pat: await resolveGitCredential(profile),
          });

          if (!rebaseResult.rebased) {
            // Conflicts — leave the branch as-is and let the parent's poller
            // surface the conflict via the PR merge gate. The fix pod still
            // completes; a follow-up fix round resolves it.
            logger.info(
              { podId, baseBranch, conflicts: rebaseResult.conflicts },
              'Fix-pod post-validation rebase produced conflicts — completing without force-push',
            );
            emitActivityStatus(
              podId,
              formatRebaseConflictReason(baseBranch, rebaseResult.conflicts),
            );
            return;
          }

          if (linkedParentIsTerminal()) {
            logger.info(
              { podId, parentId: fixPod.linkedPodId },
              'Skipping fix-pod push because linked parent became terminal during rebase',
            );
            return;
          }

          await publishFixSource(
            podRepo,
            parent,
            fixPod,
            profile.repoUrl,
            worktreeManager,
            await resolveGitCredential(profile),
          );
          branchPushed = true;
          if (!rebaseResult.alreadyUpToDate) {
            emitActivityStatus(podId, 'Rebased fix branch pushed');
          } else {
            emitActivityStatus(podId, 'Fix branch pushed');
          }
        });
      } catch (err) {
        parkFixPodDeliveryFailure(podRepo.getOrThrow(podId), err);
        return;
      }
    }

    if (branchPushed) {
      await postFixPodReviewFeedbackReplies(podRepo.getOrThrow(podId));
    }

    emitActivityStatus(podId, 'Fix pod complete — parent poller owns the merge');
    await cleanupContainer(fixPod, 'fix-pod-pushed');
    const approved = transition(fixPod, 'approved');
    const merging = transition(approved, 'merging');
    const completed = transition(merging, 'complete', {
      completedAt: new Date().toISOString(),
    });

    eventBus.emit({
      type: 'pod.completed',
      timestamp: new Date().toISOString(),
      podId,
      finalStatus: 'complete',
      summary: {
        id: podId,
        profileName: completed.profileName,
        task: completed.task,
        status: 'complete',
        model: completed.model,
        runtime: completed.runtime,
        duration: completed.startedAt ? Date.now() - new Date(completed.startedAt).getTime() : null,
        filesChanged: completed.filesChanged,
        createdAt: completed.createdAt,
      },
    });

    logger.info(
      { podId, parentId: fixPod.linkedPodId },
      'Fix pod completed after push — parent merge poller will re-attempt merge',
    );
  }
  return { completeFixPodAfterPush };
}
