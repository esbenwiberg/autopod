import type { OperatorActor, Pod } from '@autopod/shared';
import { AutopodError } from '@autopod/shared';
import { actorLabel } from './approval-policy.js';
import type {
  PodCreator,
  WorkspaceManualFixCalls,
  WorkspaceManualFixCaptured,
  WorkspaceManualFixLiveDependencies,
} from './workspace-contracts.js';

export function createWorkspaceManualFix(
  deps: WorkspaceManualFixLiveDependencies,
  captured: WorkspaceManualFixCaptured,
) {
  const { podRepo, assertExecutionTerminationVerified, logger, emitActivityStatus } = captured;

  async function fixManually(
    this: WorkspaceManualFixCalls,
    podId: string,
    actorOrUserId: OperatorActor | string,
    creator?: PodCreator,
    instructions?: string,
  ): Promise<Pod> {
    const worker = podRepo.getOrThrow(podId);
    const actor: OperatorActor =
      typeof actorOrUserId === 'string' ? { type: 'human', userId: actorOrUserId } : actorOrUserId;
    if (
      worker.status !== 'failed' &&
      worker.status !== 'review_required' &&
      worker.status !== 'validated'
    ) {
      throw new AutopodError(
        `Cannot fix pod ${podId} in status ${worker.status} — only failed, review_required, or validated pods`,
        'INVALID_STATE',
        409,
      );
    }

    if (worker.launchConfigDigest) {
      assertExecutionTerminationVerified(worker.id);
      const create = this.createResolvedSession?.bind(this);
      if (!create)
        throw new AutopodError(
          'Composable execution is unavailable',
          'CONFIG_EXECUTION_UNAVAILABLE',
          503,
        );
      if (!deps.launchConfiguration?.admitDerived)
        throw new AutopodError(
          'Frozen manual-fix admission is unavailable',
          'CONFIG_EXECUTION_UNAVAILABLE',
          503,
        );
      const userId = actor.type === 'human' ? actor.userId : `${actor.type}:${actorLabel(actor)}`;
      const id = await deps.launchConfiguration.admitDerived(
        {
          source: { kind: 'manual-fix', podId: worker.id, digest: worker.launchConfigDigest },
          task: [
            `${actorLabel(actor)} fix for pod ${worker.id}: ${worker.task}`,
            ...(instructions?.trim() ? [`Instructions: ${instructions.trim()}`] : []),
          ].join('\n\n'),
          work: {
            branch: worker.branch,
            baseBranch: worker.baseBranch ?? undefined,
            linkedPodId: worker.id,
            dependsOnPodIds: [],
            startBranch: undefined,
            seriesId: undefined,
            seriesName: undefined,
            briefTitle: undefined,
            prMode: undefined,
            waitForMerge: false,
            specFiles: undefined,
          },
        },
        (config) => create(config, userId, creator, actor).id,
      );
      return podRepo.getOrThrow(id);
    }

    // Create a workspace pod on the same branch, linked to the failed worker
    const workspace = this.createSession(
      {
        profileName: worker.profileName,
        task: [
          `${actorLabel(actor)} fix for pod ${worker.id}: ${worker.task}`,
          ...(instructions?.trim() ? [`Instructions: ${instructions.trim()}`] : []),
        ].join('\n\n'),
        branch: worker.branch,
        outputMode: 'workspace',
        baseBranch: worker.baseBranch ?? undefined,
        linkedPodId: worker.id,
      },
      actor.type === 'human' ? actor.userId : `${actor.type}:${actorLabel(actor)}`,
      creator,
    );

    logger.info(
      { workerId: podId, workspaceId: workspace.id },
      'Created linked workspace for operator fix',
    );
    emitActivityStatus(podId, `${actorLabel(actor)} fix workspace created: ${workspace.id}`);

    return workspace;
  }
  return { fixManually };
}
