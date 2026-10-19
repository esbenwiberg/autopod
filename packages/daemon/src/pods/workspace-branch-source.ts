import type { Pod } from '@autopod/shared';
import { AutopodError } from '@autopod/shared';
import type { WorkspaceBranchSourceCaptured } from './workspace-contracts.js';

export function createWorkspaceBranchSource(captured: WorkspaceBranchSourceCaptured) {
  const { podRepo, logger } = captured;
  const resolveBranchSource = (parent: Pod): Pod => {
    if (parent.prMode !== 'single') return parent;
    if (!parent.seriesId) {
      throw new AutopodError(
        `Pod ${parent.id} has prMode='single' but no seriesId — cannot resolve PR owner`,
        'INVALID_STATE',
        500,
      );
    }
    const seriesPods = podRepo.getPodsBySeries(parent.seriesId);
    const prOwners = seriesPods.filter((p) => p.prUrl);
    if (prOwners.length === 0) {
      throw new AutopodError(
        `Cannot spawn fix pod for pod ${parent.id}: no pod in series ${parent.seriesId} owns a PR yet`,
        'INVALID_STATE',
        409,
      );
    }
    let prOwner = prOwners[0] as Pod;
    if (prOwners.length > 1) {
      const matching = parent.prUrl ? prOwners.find((p) => p.prUrl === parent.prUrl) : undefined;
      prOwner = matching ?? prOwner;
      logger.warn(
        {
          podId: parent.id,
          seriesId: parent.seriesId,
          prOwnerCount: prOwners.length,
          chosenPodId: prOwner.id,
        },
        'Single-mode series has multiple PR-owning pods — picked one deterministically',
      );
    }
    if (prOwner.id !== parent.id) {
      logger.info(
        {
          podId: parent.id,
          prOwnerId: prOwner.id,
          prOwnerBranch: prOwner.branch,
          triggeringBranch: parent.branch,
        },
        'Fix pod redirected to PR-owning pod in single-mode series',
      );
    }
    return prOwner;
  };

  return { resolveBranchSource };
}
