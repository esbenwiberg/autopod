import type { Pod } from '@autopod/shared';
import type { Logger } from 'pino';
import type { SandboxContainerManager } from '../containers/sandbox-container-manager.js';
import type { EventBus } from './event-bus.js';
import type { PodRepository } from './pod-repository.js';

export interface ReconcilerDependencies {
  podRepo: PodRepository;
  eventBus: EventBus;
  sandboxContainerManager: SandboxContainerManager;
  onReconnected: (podId: string, containerId: string) => Promise<void>;
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
  const { sandboxContainerManager, podRepo, eventBus, onReconnected, logger } = deps;
  if (!pod.containerId) return;
  const containerId = pod.containerId;

  const status = await sandboxContainerManager.getStatus(containerId);

  switch (status) {
    case 'running': {
      // Sandbox still running — reconnect and resume event consumption
      logger.info({ podId: pod.id, containerId }, 'Sandbox still running, reconnecting');
      await onReconnected(pod.id, containerId);
      break;
    }

    case 'stopped': {
      // Sandbox finished — trigger completion handling
      logger.info({ podId: pod.id, containerId }, 'Sandbox stopped, triggering completion');
      // Mark as completing — the pod manager's handleCompletion will take over
      await onReconnected(pod.id, containerId);
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
