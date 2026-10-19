import { AutopodError } from '@autopod/shared';
import { cleanupClaudeState } from '../runtimes/claude-state-store.js';
import { cleanupCodexState } from '../runtimes/codex-state-store.js';
import type { OperatorKillCaptured, OperatorKillLiveDependencies } from './operator-contracts.js';
import { nativeSessionId } from './provider-attempt-policy.js';
import { canKill } from './state-machine.js';
export function createOperatorKill(
  deps: OperatorKillLiveDependencies,
  captured: OperatorKillCaptured,
) {
  const {
    podRepo,
    clearPreviewTimer,
    stopSandboxPreviewProxy,
    stopMergePolling,
    emitActivityStatus,
    transition,
    validationAbortControllers,
    killSidecarsForPod,
    cleanupTestRunBranches,
    containerManagerFactory,
    persistRuntimeCredentialsForPod,
    ownsLifecycle,
    logger,
    destroyPodNetwork,
    runtimeRegistry,
    worktreeManager,
    forgetMaxCredentialLineage,
    eventBus,
  } = captured;
  async function killSession(podId: string): Promise<void> {
    podRepo.deletionOwnership?.assertTaskAvailable(podId);
    clearPreviewTimer(podId);
    await stopSandboxPreviewProxy(podId);
    stopMergePolling(podId);
    const pod = podRepo.getOrThrow(podId);
    if (!canKill(pod.status)) {
      throw new AutopodError(
        `Cannot kill pod ${podId} in status ${pod.status}`,
        'INVALID_STATE',
        409,
      );
    }

    emitActivityStatus(podId, 'Killing pod…');
    transition(pod, 'killing');
    validationAbortControllers.get(podId)?.abort();

    // Run cleanup with a timeout so a hung Docker stop or git cleanup
    // can never leave the pod stuck in 'killing' forever.
    const KILL_TIMEOUT_MS = 30_000;
    const ownsKillLifecycle = () =>
      podRepo.getOrThrow(podId).lifecycleGeneration === pod.lifecycleGeneration;
    const cleanup = async () => {
      if (deps.launchConfiguration?.read(podId)?.intent === 'goal') {
        if (!deps.launchConfiguration.goals)
          throw new AutopodError('Native Goal controls are unavailable', 'GOAL_UNAVAILABLE', 503);
        await deps.launchConfiguration.goals.control(podId, 'cancel');
        if (!ownsKillLifecycle()) return;
      }
      // Kill sidecars before the main container so they can't outlive their pod.
      await killSidecarsForPod(podId);
      if (!ownsKillLifecycle()) return;
      await cleanupTestRunBranches(podId);
      if (!ownsKillLifecycle()) return;
      // Kill container
      if (pod.containerId) {
        const cm = containerManagerFactory.get(pod.executionTarget);
        // Best-effort: recover runtime credentials before the container dies.
        await persistRuntimeCredentialsForPod(
          podId,
          'Failed to persist rotated credentials during kill — proceeding',
        );
        if (!ownsKillLifecycle()) return;
        try {
          await cm.kill(pod.containerId);
          if (ownsLifecycle(podId, pod.lifecycleGeneration, pod.containerId)) {
            podRepo.update(podId, { containerId: null });
          }
        } catch (err) {
          logger.warn({ err, podId }, 'Failed to kill container');
        }
      }
      if (!ownsKillLifecycle()) return;
      // Remove the per-pod bridge network. Safe now that both the pod and
      // its sidecars are dead; Docker would otherwise refuse the remove.
      await destroyPodNetwork(podId);
      if (!ownsKillLifecycle()) return;

      // Abort runtime
      try {
        const runtime = runtimeRegistry.get(pod.runtime);
        await runtime.abort(podId);
      } catch (err) {
        logger.warn({ err, podId }, 'Failed to abort runtime');
      }

      if (!ownsKillLifecycle()) return;
      // Cleanup worktree — always clear the DB path even if cleanup throws,
      // so a subsequent rework doesn't attempt recovery on a stale directory.
      if (pod.worktreePath) {
        try {
          await worktreeManager.cleanup(pod.worktreePath);
        } catch (err) {
          logger.warn({ err, podId }, 'Failed to cleanup worktree');
        }
        if (!ownsKillLifecycle()) return;
        podRepo.update(podId, { worktreePath: null });
      }

      // Cleanup per-pod conversation-history dirs on the host. Best
      // effort — if they linger they just waste a few KB of disk per pod.
      const runtimeStateDirs: Partial<Record<string, (id: string) => Promise<void>>> = {
        claude: cleanupClaudeState,
        codex: cleanupCodexState,
      };
      await runtimeStateDirs[pod.runtime]?.(podId)?.catch((err) => {
        logger.warn({ err, podId }, `Failed to cleanup ${pod.runtime} state dir`);
      });
    };

    let killTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        cleanup(),
        new Promise<void>((resolve) => {
          killTimer = setTimeout(() => {
            logger.warn({ podId }, 'Kill cleanup timed out — forcing killed');
            resolve();
          }, KILL_TIMEOUT_MS);
        }),
      ]);
    } finally {
      if (killTimer) clearTimeout(killTimer);
    }

    if (!ownsKillLifecycle()) return;

    const activeAttempt = deps.providerAttemptRepo?.getActive(podId);
    if (activeAttempt) {
      const latestPod = podRepo.getOrThrow(podId);
      deps.providerAttemptRepo?.close(podId, {
        nativeSessionId: nativeSessionId(latestPod),
        outcome: 'aborted',
        inputTokens: activeAttempt.inputTokens,
        outputTokens: activeAttempt.outputTokens,
        costUsd: activeAttempt.costUsd,
      });
    }
    const killingSession = podRepo.getOrThrow(podId);
    transition(killingSession, 'killed', { completedAt: new Date().toISOString() });
    forgetMaxCredentialLineage(podId);

    eventBus.emit({
      type: 'pod.completed',
      timestamp: new Date().toISOString(),
      podId,
      finalStatus: 'killed',
      summary: {
        id: podId,
        profileName: pod.profileName,
        task: pod.task,
        status: 'killed',
        model: pod.model,
        runtime: pod.runtime,
        duration: pod.startedAt ? Date.now() - new Date(pod.startedAt).getTime() : null,
        filesChanged: pod.filesChanged,
        createdAt: pod.createdAt,
      },
    });

    logger.info({ podId }, 'Pod killed');
  }
  return { killSession };
}
