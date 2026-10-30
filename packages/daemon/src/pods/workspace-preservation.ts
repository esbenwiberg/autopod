import type { Pod } from '@autopod/shared';
import type { Logger } from 'pino';
import type { ContainerManager } from '../interfaces/container-manager.js';
import {
  type WorkspaceCheckpointResult,
  checkpointSandboxWorkspace,
} from '../worktrees/sandbox-workspace-checkpoint.js';
import type { WorkspaceCheckpointController } from './workspace-checkpoint-controller.js';

interface WorkspacePreservationDependencies {
  captureAuthority(pod: Pod): () => void;
  getContainerManager(target: Pod['executionTarget']): ContainerManager;
  syncWorkspaceBack(
    containerId: string,
    worktreePath: string,
    cm: ContainerManager,
    podId: string,
    executionTarget: Pod['executionTarget'],
  ): Promise<{ pushed: boolean }>;
  workspaceCheckpointController?: Pick<WorkspaceCheckpointController, 'request'>;
  sandboxWorkspaceCheckpoint?: typeof checkpointSandboxWorkspace;
  logger: Pick<Logger, 'info'>;
  emitActivityStatus(podId: string, message: string): void;
}

/** Preserve source through existing transfer paths; callers retain lifecycle authority. */
export function createWorkspacePreservation(deps: WorkspacePreservationDependencies): {
  preservePodWorkspace(pod: Pod, reason: string): Promise<void>;
  checkpointSandboxWorkspaceForPod(pod: Pod): Promise<WorkspaceCheckpointResult>;
} {
  const {
    getContainerManager,
    syncWorkspaceBack,
    workspaceCheckpointController,
    sandboxWorkspaceCheckpoint,
    logger,
    emitActivityStatus,
  } = deps;

  // Completion, explicit recovery, and destructive-boundary preservation can race.
  // One immutable checkpoint per pod makes duplicate requests observationally identical.
  const sandboxCheckpointRuns = new Map<string, Promise<WorkspaceCheckpointResult>>();

  async function preservePodWorkspace(pod: Pod, reason: string): Promise<void> {
    const assertCurrent = deps.captureAuthority(pod);
    assertCurrent();
    if (!pod.containerId || !pod.worktreePath) return;
    const cm = getContainerManager(pod.executionTarget);
    if (pod.executionTarget === 'sandbox') {
      const status = await cm.getStatus(pod.containerId);
      assertCurrent();
      if (status === 'unknown') {
        throw new Error(`Sandbox ${pod.containerId} is unavailable for workspace preservation`);
      }
      if (status === 'stopped') {
        assertCurrent();
        await cm.start(pod.containerId, { assertCurrent });
        assertCurrent();
      }
    }
    if (pod.executionTarget === 'sandbox') {
      const checkpoint = await checkpointSandboxWorkspaceForPod(pod);
      if (!checkpoint.promoted || !checkpoint.materialized || !checkpoint.lineageVerified) {
        throw new Error(checkpoint.error?.message ?? 'sandbox checkpoint was not fully verified');
      }
      emitActivityStatus(pod.id, `Verified workspace checkpoint before ${reason}.`);
      return;
    }
    const result = await syncWorkspaceBack(
      pod.containerId,
      pod.worktreePath,
      cm,
      pod.id,
      pod.executionTarget,
    );
    logger.info(
      {
        podId: pod.id,
        containerId: pod.containerId,
        executionTarget: pod.executionTarget,
        reason,
        commitsPushed: result.pushed,
      },
      'Workspace preserved before recovery boundary',
    );
    emitActivityStatus(pod.id, `Workspace preserved before ${reason}.`);
  }

  async function checkpointSandboxWorkspaceForPod(pod: Pod): Promise<WorkspaceCheckpointResult> {
    const assertCurrent = deps.captureAuthority(pod);
    assertCurrent();
    if (!pod.containerId || !pod.worktreePath) {
      return {
        sequence: 0,
        sourceHead: '',
        sourceTree: '',
        snapshotCommit: '',
        snapshotTree: '',
        transferVerified: false,
        bundleVerified: false,
        hostImported: false,
        lineageVerified: false,
        promoted: false,
        materialized: false,
        quarantineRef: '',
        error: {
          phase: 'capture',
          code: 'NO_WORKSPACE',
          retryable: false,
          message: 'Sandbox pod has no container or Git worktree',
        },
      };
    }
    const existing = sandboxCheckpointRuns.get(pod.id);
    if (existing) return existing;
    if (workspaceCheckpointController) {
      const decision = await workspaceCheckpointController.request(
        pod.id,
        'completion',
        undefined,
        assertCurrent,
      );
      assertCurrent();
      if (decision.result) return decision.result;
    }
    const run = (sandboxWorkspaceCheckpoint ?? checkpointSandboxWorkspace)({
      containerManager: getContainerManager('sandbox'),
      containerId: pod.containerId,
      podId: pod.id,
      worktreePath: pod.worktreePath,
      sequence: Date.now(),
      assertCurrent,
    }).finally(() => sandboxCheckpointRuns.delete(pod.id));
    sandboxCheckpointRuns.set(pod.id, run);
    return run;
  }

  return { preservePodWorkspace, checkpointSandboxWorkspaceForPod };
}
