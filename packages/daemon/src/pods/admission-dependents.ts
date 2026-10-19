import type { Pod } from '@autopod/shared';
import type { AdmissionDependentsCaptured } from './admission-contracts.js';
import { isSinglePrSeriesPod } from './delivery-policy.js';
export function createAdmissionDependents(captured: AdmissionDependentsCaptured) {
  const { podRepo, logger, eventBus, enqueueSession } = captured;
  function maybeTriggerDependents(completedPod: Pod): void {
    const dependents = podRepo.getPodsDependingOn(completedPod.id);
    for (const dep of dependents) {
      // Also heal pods that were cascade-failed when this parent was previously killed.
      // The mergeBlockReason marker identifies exactly those pods so we don't disturb
      // genuinely-failed dependents that have their own failure reason.
      const cascadeFailed =
        dep.status === 'failed' &&
        dep.mergeBlockReason === `dependency pod ${completedPod.id} failed`;
      if (dep.status !== 'queued' && !cascadeFailed) continue;

      const parentIds =
        dep.dependsOnPodIds.length > 0
          ? dep.dependsOnPodIds
          : dep.dependsOnPodId
            ? [dep.dependsOnPodId]
            : [];
      if (parentIds.length === 0) continue;

      const parentsReady = parentIds.every((pid) => {
        let parent: Pod;
        try {
          parent = pid === completedPod.id ? completedPod : podRepo.getOrThrow(pid);
        } catch {
          // Missing parent — treat as not ready rather than crashing.
          return false;
        }
        if (isSinglePrSeriesPod(dep)) {
          return parent.status === 'complete';
        }
        // Shared branch (single-mode siblings): the parent holds the Git worktree
        // lock on the branch until it reaches 'complete' — worktree is cleaned up
        // on completion, not on validation. Starting the child early races into
        // an empty worktree and the repoint step fails. Wait for 'complete'.
        if (parent.branch === dep.branch) {
          return parent.status === 'complete';
        }
        if (dep.waitForMerge) {
          // Stacked series: wait until the parent PR is fully merged.
          return parent.status === 'complete';
        }
        // Accept any terminal-success status — a manually approved parent reaches
        // 'complete' without passing through 'validated' in the dependent's view.
        return (
          parent.status === 'validated' ||
          parent.status === 'approved' ||
          parent.status === 'merging' ||
          parent.status === 'merge_pending' ||
          parent.status === 'complete'
        );
      });
      if (!parentsReady) {
        logger.debug(
          {
            podId: dep.id,
            parentIds,
            waitingOn: parentIds.filter((pid) => pid !== completedPod.id),
          },
          'Series: dependent pod still waiting on other parents',
        );
        continue;
      }

      // Determine base branch for the dependent pod:
      // - Single-PR series, even if an older row has the wrong child branch:
      //   keep pointing at the real base so the final PR targets main/default.
      // - Single-branch (shared branch): same real-base rule.
      // - Stacked with waitForMerge: parent branch is deleted post-merge; use parent's
      //   baseBranch (main) so the dependent starts from the freshly-merged main.
      // - Stacked without waitForMerge: stack directly on parent's branch (classic stacking).
      const firstParentId = parentIds[0];
      const firstParent = firstParentId
        ? firstParentId === completedPod.id
          ? completedPod
          : podRepo.getOrThrow(firstParentId)
        : completedPod;
      const isSharedBranch = dep.branch === firstParent.branch;
      let baseBranch: string;
      if (dep.launchConfigDigest && dep.baseBranch) {
        // Composed launches already froze their source binding at admission.
        baseBranch = dep.baseBranch;
      } else if (isSinglePrSeriesPod(dep) || isSharedBranch || dep.waitForMerge) {
        baseBranch = firstParent.baseBranch ?? 'main';
      } else {
        baseBranch = firstParent.branch;
      }

      if (cascadeFailed) {
        podRepo.update(dep.id, { status: 'queued', completedAt: null, mergeBlockReason: null });
        eventBus.emit({
          type: 'pod.status_changed',
          timestamp: new Date().toISOString(),
          podId: dep.id,
          previousStatus: 'failed',
          newStatus: 'queued',
        });
        logger.info(
          { podId: dep.id, parentId: completedPod.id },
          'Series: healed cascade-failed dependent — parent completed',
        );
      }
      podRepo.update(dep.id, {
        baseBranch,
        dependencyStartedAt: new Date().toISOString(),
      });
      enqueueSession(dep.id);
      logger.info({ podId: dep.id, parentIds, baseBranch }, 'Series: dependent pod enqueued');
    }
  }

  function rehydrateDependentSessions(): void {
    const PARENT_DONE = new Set(['validated', 'approved', 'merging', 'merge_pending', 'complete']);
    const stuckDeps = podRepo
      .list({ status: 'queued' })
      .filter((p) => p.dependsOnPodIds.length > 0 || !!p.dependsOnPodId);

    for (const dep of stuckDeps) {
      const parentIds =
        dep.dependsOnPodIds.length > 0
          ? dep.dependsOnPodIds
          : dep.dependsOnPodId
            ? [dep.dependsOnPodId]
            : [];
      if (parentIds.length === 0) continue;

      const allParentsDone = parentIds.every((pid) => {
        try {
          const parent = podRepo.getOrThrow(pid);
          if (isSinglePrSeriesPod(dep)) {
            return parent.status === 'complete';
          }
          // Shared branch: parent must reach 'complete' before its worktree
          // releases the branch lock. See maybeTriggerDependents for rationale.
          if (parent.branch === dep.branch) {
            return parent.status === 'complete';
          }
          return PARENT_DONE.has(parent.status);
        } catch {
          return false;
        }
      });
      if (!allParentsDone) continue;

      // Enqueue each stuck pod directly (once per pod) rather than calling
      // maybeTriggerDependents which iterates *all* dependents of the parent
      // and would fire multiple times if called once per stuck dep in the loop.
      const firstParentId = parentIds[0];
      if (!firstParentId) continue;
      try {
        const firstParent = podRepo.getOrThrow(firstParentId);
        const baseBranch =
          dep.launchConfigDigest && dep.baseBranch
            ? dep.baseBranch
            : isSinglePrSeriesPod(dep) || dep.waitForMerge || dep.branch === firstParent.branch
              ? (firstParent.baseBranch ?? 'main')
              : firstParent.branch;
        podRepo.update(dep.id, {
          baseBranch,
          dependencyStartedAt: new Date().toISOString(),
        });
        enqueueSession(dep.id);
        logger.info(
          { podId: dep.id, firstParentId, baseBranch },
          'Series: rehydrated stuck dependent pod',
        );
      } catch {
        logger.warn({ podId: dep.id }, 'rehydrate: failed to enqueue dependent');
      }
    }
  }
  return { maybeTriggerDependents, rehydrateDependentSessions };
}
