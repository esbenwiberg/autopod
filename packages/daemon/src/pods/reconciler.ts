import type { Pod } from '@autopod/shared';
import type { Logger } from 'pino';
import type { AciContainerManager } from '../containers/aci-container-manager.js';
import type { EventBus } from './event-bus.js';
import type { PodRepository } from './pod-repository.js';

export interface ReconcilerDependencies {
  podRepo: PodRepository;
  eventBus: EventBus;
  aciContainerManager: AciContainerManager;
  onReconnected: (podId: string, containerId: string) => Promise<void>;
  logger: Logger;
}

/**
 * Reconciles ACI pods on daemon restart.
 *
 * Finds pods with status='running' and executionTarget='aci',
 * checks their container state, and either reconnects or marks them failed.
 */
export async function reconcileAciSessions(deps: ReconcilerDependencies): Promise<void> {
  const { podRepo, eventBus, logger } = deps;

  // Find all running ACI pods
  const runningSessions = podRepo.list({ status: 'running' });
  const aciSessions = runningSessions.filter((s) => s.executionTarget === 'aci' && s.containerId);

  if (aciSessions.length === 0) {
    logger.info('No ACI pods to reconcile');
    return;
  }

  logger.info({ count: aciSessions.length }, 'Reconciling ACI pods');

  for (const pod of aciSessions) {
    try {
      await reconcileSession(pod, deps);
    } catch (err) {
      logger.error({ err, podId: pod.id }, 'Failed to reconcile ACI pod');
      markSessionFailed(pod, podRepo, eventBus, logger);
    }
  }
}

async function reconcileSession(pod: Pod, deps: ReconcilerDependencies): Promise<void> {
  const { aciContainerManager, podRepo, eventBus, onReconnected, logger } = deps;
  if (!pod.containerId) return;
  const containerId = pod.containerId;

  const status = await aciContainerManager.getStatus(containerId);

  switch (status) {
    case 'running': {
      // Container still running — reconnect log stream and resume event consumption
      logger.info(
        { podId: pod.id, containerId },
        'ACI container still running, reconnecting',
      );
      await onReconnected(pod.id, containerId);
      break;
    }

    case 'stopped': {
      // Container finished — trigger completion handling
      logger.info(
        { podId: pod.id, containerId },
        'ACI container stopped, triggering completion',
      );
      // Mark as completing — the pod manager's handleCompletion will take over
      await onReconnected(pod.id, containerId);
      break;
    }

    case 'unknown': {
      // Container gone — mark pod as failed
      logger.warn(
        { podId: pod.id, containerId },
        'ACI container not found, marking pod failed',
      );
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

    logger.info({ podId: pod.id }, 'ACI pod marked as killed after reconciliation');
  } catch (err) {
    logger.error({ err, podId: pod.id }, 'Failed to mark ACI pod as failed');
  }
}
