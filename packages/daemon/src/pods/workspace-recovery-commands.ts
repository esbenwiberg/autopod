import { AutopodError } from '@autopod/shared';
import type { WorkspaceRecoveryCommandsCaptured } from './workspace-contracts.js';

export function createWorkspaceRecoveryCommands(captured: WorkspaceRecoveryCommandsCaptured) {
  const {
    preservePodWorkspace,
    podRepo,
    containerManagerFactory,
    emitActivityStatus,
    killSidecarsForPod,
    destroyPodNetwork,
    checkpointSandboxWorkspaceForPod,
    recoverWorktreeFromContainer,
    executionForPod,
    worktreeManager,
    logger,
  } = captured;

  async function preserveWorkspace(podId: string, reason = 'operator recovery'): Promise<void> {
    await preservePodWorkspace(podRepo.getOrThrow(podId), reason);
  }

  async function quiesceSandboxAgent(podId: string): Promise<void> {
    const pod = podRepo.getOrThrow(podId);
    if (pod.executionTarget !== 'sandbox' || !pod.containerId) return;
    const cm = containerManagerFactory.get('sandbox');
    if ((await cm.getStatus(pod.containerId)) !== 'running') return;
    const result = await cm.execInContainer(
      pod.containerId,
      [
        'sh',
        '-c',
        [
          'pid_file=/run/autopod/agent.pid',
          '[ -r "$pid_file" ] || { echo "missing agent PID" >&2; exit 70; }',
          'pid=$(cat "$pid_file")',
          'case "$pid" in ""|*[!0-9]*) rm -f "$pid_file"; exit 0;; esac',
          'kill -TERM "$pid" 2>/dev/null || true',
          'i=0; while kill -0 "$pid" 2>/dev/null && [ "$i" -lt 20 ]; do sleep 0.1; i=$((i + 1)); done',
          'kill -KILL "$pid" 2>/dev/null || true',
          'rm -f "$pid_file"',
        ].join('; '),
      ],
      { timeout: 5_000 },
    );
    if (result.exitCode !== 0) {
      throw new Error(`Sandbox worker quiesce failed (exit ${result.exitCode}): ${result.stderr}`);
    }
    emitActivityStatus(podId, 'Orphaned sandbox worker stopped for daemon recovery.');
  }

  async function suspendSandboxForRecovery(podId: string): Promise<void> {
    const pod = podRepo.getOrThrow(podId);
    if (pod.executionTarget !== 'sandbox' || !pod.containerId) return;
    const cm = containerManagerFactory.get('sandbox');
    if ((await cm.getStatus(pod.containerId)) === 'running') await cm.stop(pod.containerId);
  }

  async function cleanupPodResourcesForRecovery(podId: string): Promise<void> {
    await killSidecarsForPod(podId, true);
    await destroyPodNetwork(podId, true);
  }

  async function recoverWorktree(podId: string): Promise<{
    recovered: boolean;
    message: string;
    blockers?: Array<{ status: string; path: string }>;
  }> {
    const pod = podRepo.getOrThrow(podId);
    if (!pod.worktreeCompromised) {
      throw new AutopodError(
        `Pod ${podId} worktree is not compromised — nothing to recover`,
        'INVALID_STATE',
        409,
      );
    }
    if (!pod.worktreePath) {
      return {
        recovered: false,
        message: 'Pod has no worktree — manual extraction needed',
      };
    }

    if (pod.executionTarget === 'sandbox') {
      if (pod.containerId) {
        const cm = containerManagerFactory.get('sandbox');
        if ((await cm.getStatus(pod.containerId)) === 'stopped') {
          await cm.start(pod.containerId);
          emitActivityStatus(podId, 'Resumed retained sandbox for checkpoint recovery.');
        }
      }
      const checkpoint = await checkpointSandboxWorkspaceForPod(pod);
      const recovered =
        checkpoint.lineageVerified && checkpoint.promoted && checkpoint.materialized;
      if (!recovered) {
        return {
          recovered: false,
          message: `Verified checkpoint recovery incomplete: ${checkpoint.error?.message ?? 'proof missing'}`,
          checkpoint,
        };
      }
      podRepo.update(podId, { worktreeCompromised: false, preSubmitReview: null });
      emitActivityStatus(podId, 'Verified checkpoint recovered and materialized the worktree.');
      return {
        recovered: true,
        message: 'Verified checkpoint recovered and materialized',
        checkpoint,
      };
    }

    // Path A — container is alive: pull /workspace from the live container,
    // overwrite the partial host worktree, then auto-commit. Most powerful
    // recovery because it captures any uncommitted state still inside the
    // container's overlayfs.
    if (pod.containerId) {
      const cm = containerManagerFactory.get(pod.executionTarget);
      const recovered = await recoverWorktreeFromContainer(
        pod.containerId,
        pod.worktreePath,
        cm,
        pod.id,
      );
      if (recovered) {
        try {
          const profileForRecovery = executionForPod(pod);
          await worktreeManager.commitPendingChangesWithGeneratedMessage(
            pod.worktreePath,
            pod.task,
            profileForRecovery,
            pod.model,
            { maxDeletions: 100 },
          );
          podRepo.update(podId, { worktreeCompromised: false });
          emitActivityStatus(podId, 'Worktree recovered from container and committed successfully');
          return { recovered: true, message: 'Worktree recovered and committed' };
        } catch (err) {
          return {
            recovered: false,
            message: `Recovery failed at commit stage: ${err instanceof Error ? err.message : String(err)}`,
          };
        }
      }
      // Live recovery failed — fall through to the bare-repo path. The
      // agent's commits may still be on the bare from a successful
      // in-container push during the original sync-back attempt.
      logger.info({ podId }, 'Live container recovery failed — trying bare-repo restore fallback');
    }

    // Path B — no container (or live recovery failed): the agent's commits
    // are typically already on the bare via the in-container `git push` step
    // of syncWorkspaceBack, even when the file-copy half timed out. The host
    // worktree's HEAD/index point at those commits — only working-tree files
    // are stale on disk. `restoreFromHead` is gated on recoverable tracked-file
    // damage so it can fix stale index/deletion/corruption states without
    // sweeping unrelated untracked work.
    const restored = await worktreeManager.restoreFromHead(pod.worktreePath, {
      allowTrackedModifications: true,
    });
    if (!restored.restored) {
      return {
        recovered: false,
        message: pod.containerId
          ? `Container not reachable and bare-repo restore refused: ${restored.reason}`
          : `No container to recover from; bare-repo restore refused: ${restored.reason}`,
        blockers: restored.blockers,
      };
    }
    podRepo.update(podId, { worktreeCompromised: false });
    emitActivityStatus(podId, `Worktree recovered from HEAD — ${restored.reason}`);
    return { recovered: true, message: restored.reason };
  }
  return {
    preserveWorkspace,
    quiesceSandboxAgent,
    suspendSandboxForRecovery,
    cleanupPodResourcesForRecovery,
    recoverWorktree,
  };
}
