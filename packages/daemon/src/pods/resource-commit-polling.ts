import { createPollingCoordinator } from './polling-coordinator.js';
import type { ResourceCommitStateCaptured } from './resource-contracts.js';

export function createResourceCommitPollingState(captured: ResourceCommitStateCaptured) {
  const { logger } = captured;
  const commitPolling = createPollingCoordinator((err, podId) =>
    logger.debug({ err, podId }, 'Commit polling failed, skipping cycle'),
  );

  return { commitPolling };
}
import type { Pod } from '@autopod/shared';
import type {
  ResourceCommitCaptured,
  ResourceCommitLiveDependencies,
} from './resource-contracts.js';
import { COMMIT_POLL_INTERVAL_MS } from './resource-policy.js';

export function createResourceCommitPolling(
  deps: ResourceCommitLiveDependencies,
  captured: ResourceCommitCaptured,
) {
  const { podRepo, commitPolling, containerManagerFactory, logger, emitActivityStatus } = captured;

  function startCommitPolling(podId: string): void {
    const expected = podRepo.getOrThrow(podId);
    let captureAttempted = false;
    commitPolling.start(podId, COMMIT_POLL_INTERVAL_MS, async (ownership) => {
      const current = (): Pod | null => {
        try {
          const pod = podRepo.getOrThrow(podId);
          if (
            ownership.isCurrent() &&
            pod.status === 'running' &&
            pod.containerId &&
            pod.lifecycleGeneration === expected.lifecycleGeneration &&
            pod.containerId === expected.containerId &&
            pod.executionTarget === expected.executionTarget &&
            pod.worktreePath === expected.worktreePath &&
            pod.branch === expected.branch &&
            pod.baseBranch === expected.baseBranch
          )
            return pod;
        } catch {
          /* Deleted or replaced pods have no polling authority. */
        }
        ownership.stop();
        return null;
      };
      let pod = current();
      if (!pod?.containerId) return;
      const cm = containerManagerFactory.get(pod.executionTarget);
      if (!captureAttempted) {
        captureAttempted = true;
        if (!pod.startCommitSha) {
          try {
            const shaResult = await cm.execInContainer(
              pod.containerId,
              ['git', 'rev-parse', 'HEAD'],
              {
                cwd: '/workspace',
                timeout: 5_000,
              },
            );
            pod = current();
            if (!pod) return;
            if (!pod.startCommitSha && shaResult.exitCode === 0 && shaResult.stdout.trim())
              podRepo.update(podId, { startCommitSha: shaResult.stdout.trim() });
          } catch {
            if (!current()) return;
            logger.debug({ podId }, 'Failed to capture start commit SHA');
          }
        }
      }
      pod = current();
      if (!pod?.containerId) return;
      // Use the captured starting SHA; retain the existing legacy base fallback.
      const exclusionRef = pod.startCommitSha ?? pod.baseBranch ?? 'main';
      const [countResult, timeResult] = await Promise.all([
        cm.execInContainer(
          pod.containerId,
          ['git', 'rev-list', '--count', 'HEAD', `^${exclusionRef}`],
          {
            cwd: '/workspace',
            timeout: 5_000,
          },
        ),
        cm.execInContainer(pod.containerId, ['git', 'log', '-1', '--format=%cI'], {
          cwd: '/workspace',
          timeout: 5_000,
        }),
      ]);
      const observed = current();
      if (!observed || observed.startCommitSha !== pod.startCommitSha) return;
      const commitCount = Number.parseInt(countResult.stdout.trim(), 10) || 0;
      const lastCommitAt = timeResult.exitCode === 0 ? timeResult.stdout.trim() : null;
      podRepo.update(podId, { commitCount, lastCommitAt });
      if (pod.executionTarget === 'sandbox') {
        const decision = await deps.workspaceCheckpointController?.poll(podId);
        if (!current()) return;
        if (decision?.degraded)
          emitActivityStatus(
            podId,
            'Durability degraded — retaining sandbox until checkpoint succeeds.',
          );
      }
    });
  }

  function stopCommitPolling(podId: string): void {
    commitPolling.stop(podId);
  }
  return { startCommitPolling, stopCommitPolling };
}
