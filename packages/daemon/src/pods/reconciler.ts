import type { Pod } from '@autopod/shared';
import type { Logger } from 'pino';
import type { SandboxContainerManager } from '../containers/sandbox-container-manager.js';
import type { EventBus } from './event-bus.js';
import type { PodRepository } from './pod-repository.js';

export interface ReconcilerDependencies {
  podRepo: PodRepository;
  eventBus: EventBus;
  sandboxContainerManager: SandboxContainerManager;
  logger: Logger;
}

/**
 * Reconciles sandbox pods on daemon restart.
 *
 * Finds pods with status='running' and executionTarget='sandbox',
 * checks their sandbox state, and either reconnects or marks them failed.
 */
export async function reconcileSandboxSessions(deps: ReconcilerDependencies): Promise<void> {
  const { podRepo, eventBus, logger } = deps;

  // Find all running sandbox pods
  const runningSessions = podRepo.list({ status: 'running' });
  const sandboxSessions = runningSessions.filter(
    (s) => s.executionTarget === 'sandbox' && s.containerId,
  );

  if (sandboxSessions.length === 0) {
    logger.info('No sandbox pods to reconcile');
    return;
  }

  logger.info({ count: sandboxSessions.length }, 'Reconciling sandbox pods');

  for (const pod of sandboxSessions) {
    try {
      await reconcileSession(pod, deps);
    } catch (err) {
      logger.error({ err, podId: pod.id }, 'Failed to reconcile sandbox pod');
      markSessionFailed(pod, podRepo, eventBus, logger);
    }
  }
}

async function reconcileSession(pod: Pod, deps: ReconcilerDependencies): Promise<void> {
  const { sandboxContainerManager, podRepo, eventBus, logger } = deps;
  if (!pod.containerId) return;
  const containerId = pod.containerId;

  const status = await sandboxContainerManager.getStatus(containerId);

  switch (status) {
    case 'running': {
      const reason =
        'Sandbox is still running after daemon restart, but the agent stream cannot be reattached; operator action is required to inspect or recover the work before continuing.';
      logger.warn({ podId: pod.id, containerId }, reason);
      parkSession(pod, 'paused', reason, podRepo, eventBus);
      break;
    }

    case 'stopped': {
      const reason =
        'Sandbox stopped while the daemon was offline; agent completion was not observed, so validation and PR creation are blocked until the worktree is recovered or the pod is kicked.';
      logger.warn({ podId: pod.id, containerId }, reason);
      parkSession(pod, 'failed', reason, podRepo, eventBus);
      break;
    }

    case 'unknown': {
      // Sandbox gone — mark pod as failed
      logger.warn({ podId: pod.id, containerId }, 'Sandbox not found, marking pod failed');
      markSessionFailed(pod, podRepo, eventBus, logger);
      break;
    }
  }
}

function parkSession(
  pod: Pod,
  status: 'paused' | 'failed',
  reason: string,
  podRepo: PodRepository,
  eventBus: EventBus,
): void {
  const previousStatus = pod.status;
  podRepo.update(pod.id, {
    status,
    pauseReason: status === 'paused' ? 'manual' : null,
    lastCorrectionMessage: reason,
    ...(status === 'failed' ? { completedAt: new Date().toISOString() } : {}),
  });

  const timestamp = new Date().toISOString();
  eventBus.emit({
    type: 'pod.status_changed',
    timestamp,
    podId: pod.id,
    previousStatus,
    newStatus: status,
  });
  eventBus.emit({
    type: 'pod.agent_activity',
    timestamp,
    podId: pod.id,
    event: { type: 'status', timestamp, message: reason },
  });
}

function markSessionFailed(
  pod: Pod,
  podRepo: PodRepository,
  eventBus: EventBus,
  logger: Logger,
): void {
  try {
    // Transition: running → killing → killed (to respect state machine)
    podRepo.update(pod.id, { status: 'killing' });
    podRepo.update(pod.id, {
      status: 'killed',
      completedAt: new Date().toISOString(),
    });

    eventBus.emit({
      type: 'pod.status_changed',
      timestamp: new Date().toISOString(),
      podId: pod.id,
      previousStatus: 'running',
      newStatus: 'killed',
    });

    eventBus.emit({
      type: 'pod.completed',
      timestamp: new Date().toISOString(),
      podId: pod.id,
      finalStatus: 'killed',
      summary: {
        id: pod.id,
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

    logger.info({ podId: pod.id }, 'Sandbox pod marked as killed after reconciliation');
  } catch (err) {
    logger.error({ err, podId: pod.id }, 'Failed to mark sandbox pod as failed');
  }
}
