import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Pod } from '@autopod/shared';
import { authenticatedGitEnvironment } from '../worktrees/authenticated-git-environment.js';
import type {
  ResourceAuxiliaryCaptured,
  ResourceAuxiliaryLiveDependencies,
} from './resource-contracts.js';
const execFileAsync = promisify(execFile);
export function createResourceAuxiliary(
  deps: ResourceAuxiliaryLiveDependencies,
  captured: ResourceAuxiliaryCaptured,
) {
  const { sidecarManager, podRepo, logger, executionForPod } = captured;

  async function killSidecarsForPod(
    podId: string,
    strict = false,
    assertCurrent?: () => void,
    retainMetadata = false,
  ): Promise<void> {
    assertCurrent?.();
    if (!sidecarManager) {
      if (strict && Object.keys(podRepo.getOrThrow(podId).sidecarContainerIds ?? {}).length > 0)
        throw new Error('Sidecar cleanup capability unavailable');
      return;
    }
    let current: Pod;
    try {
      current = podRepo.getOrThrow(podId);
    } catch {
      return;
    }
    const ids = current.sidecarContainerIds;
    if (!ids) return;
    const entries = Object.entries(ids);
    const results = await Promise.allSettled(
      entries.map(([, containerId]) => sidecarManager.kill(containerId)),
    );
    const failures: unknown[] = [];
    for (const [index, result] of results.entries()) {
      if (result.status === 'fulfilled') continue;
      const [name, containerId] = entries[index] ?? ['unknown', 'unknown'];
      failures.push(result.reason);
      logger.warn(
        { err: result.reason, podId, sidecarName: name, containerId },
        'Failed to kill sidecar',
      );
    }
    if (failures.length > 0 && strict) {
      throw new AggregateError(failures, `Failed to clean up sidecars for pod ${podId}`);
    }
    assertCurrent?.();
    if (!retainMetadata) podRepo.update(podId, { sidecarContainerIds: null });
  }

  async function cleanupTestRunBranches(
    podId: string,
    options?: { strict: boolean; assertCurrent: () => void; retainMetadata?: boolean },
  ): Promise<void> {
    options?.assertCurrent();
    let current: Pod;
    try {
      current = podRepo.getOrThrow(podId);
    } catch {
      return;
    }
    const branches = current.testRunBranches;
    if (!branches || branches.length === 0) return;
    const profile = executionForPod(current);
    const cfg = profile.testPipeline;
    if (!cfg || !cfg.enabled || !deps.azureDevOpsAuth) {
      if (options?.strict) throw new Error('Test branch cleanup capability unavailable');
      podRepo.update(podId, { testRunBranches: null });
      return;
    }
    const token = await deps.azureDevOpsAuth.getToken();
    options?.assertCurrent();
    if (!current.worktreePath) {
      // No worktree to run git from. Can't delete; leave a daily sweep to reap.
      if (options?.strict) throw new Error('Test branch worktree unavailable');
      logger.warn({ podId, branches }, 'Cannot cleanup test-run branches — pod has no worktree');
      podRepo.update(podId, { testRunBranches: null });
      return;
    }
    const results = await Promise.allSettled(
      branches.map(async (branch) => {
        try {
          options?.assertCurrent();
          await execFileAsync(
            'git',
            ['-C', current.worktreePath as string, 'push', cfg.testRepo, '--delete', branch],
            {
              timeout: 30_000,
              env: authenticatedGitEnvironment(cfg.testRepo, `Bearer ${token}`),
            },
          );
        } catch (err) {
          // Git errors can include authentication headers; never retain the raw provider error.
          logger.warn({ podId, branch }, 'Failed to delete test-run branch');
          if (options?.strict) throw new Error('Test branch deletion was not confirmed');
        }
      }),
    );
    options?.assertCurrent();
    if (options?.strict && results.some((result) => result.status === 'rejected'))
      throw new Error('Test branch cleanup incomplete');
    if (!options?.retainMetadata) podRepo.update(podId, { testRunBranches: null });
  }
  return { killSidecarsForPod, cleanupTestRunBranches };
}
