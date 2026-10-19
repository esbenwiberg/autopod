import type { Pod } from '@autopod/shared';
import type { GitTransientFetchError } from '../worktrees/local-worktree-manager.js';
import type { WorkspaceHostFetchCaptured } from './workspace-contracts.js';

export function createWorkspaceHostFetchRetry(captured: WorkspaceHostFetchCaptured) {
  const { podRepo, enqueueSession, emitActivityStatus } = captured;
  const hostFetchRetryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  function scheduleHostFetchRetry(pod: Pod, error: GitTransientFetchError): void {
    const previous = pod.infrastructureFailure;
    const attemptCount =
      previous?.source === 'git-fetch' &&
      previous.branch === error.branch &&
      previous.purpose === error.purpose
        ? previous.attemptCount + 1
        : 1;
    const delayMs = attemptCount === 1 ? 30_000 : attemptCount === 2 ? 120_000 : 300_000;
    const retryNotBefore = new Date(Date.now() + delayMs).toISOString();
    podRepo.update(pod.id, {
      infrastructureFailure: {
        source: 'git-fetch',
        code: 'GIT_FETCH_TRANSIENT',
        branch: error.branch,
        purpose: error.purpose,
        diagnostics: error.diagnostics,
        attemptCount,
        occurredAt: new Date().toISOString(),
        recoveryDisposition: 'automatic_retry_scheduled',
        retryNotBefore,
      },
      failureReason: null,
    });
    const existing = hostFetchRetryTimers.get(pod.id);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      hostFetchRetryTimers.delete(pod.id);
      let current: Pod;
      try {
        current = podRepo.getOrThrow(pod.id);
      } catch {
        return;
      }
      if (
        current?.status === 'queued' &&
        current.infrastructureFailure?.source === 'git-fetch' &&
        current.infrastructureFailure.retryNotBefore === retryNotBefore
      ) {
        enqueueSession(pod.id);
      }
    }, delayMs);
    timer.unref();
    hostFetchRetryTimers.set(pod.id, timer);
    emitActivityStatus(
      pod.id,
      `Remote ${error.purpose} branch fetch failed; retrying automatically.`,
    );
  }
  return { scheduleHostFetchRetry };
}
