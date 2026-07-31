import type { Pod } from '@autopod/shared';
import type { Logger } from 'pino';
import type { SandboxContainerManager } from '../containers/sandbox-container-manager.js';
import type { EventBus } from './event-bus.js';
import type { PodRepository } from './pod-repository.js';

export interface ReconcilerDependencies {
  podRepo: PodRepository;
  eventBus: EventBus;
  sandboxContainerManager: SandboxContainerManager;
  preserveWorkspace: (podId: string) => Promise<void>;
  logger: Logger;
}

/**
 * Reconciles sandbox pods on daemon restart.
 *
 * Finds active or parked pods with executionTarget='sandbox', checks their
 * sandbox state, and preserves recoverable work without restarting the agent.
 */
export async function reconcileSandboxSessions(deps: ReconcilerDependencies): Promise<void> {
  const { podRepo, eventBus, logger } = deps;

  // Paused and awaiting-input pods can still contain workspace state that never
  // reached the host before an earlier crash. Include them so deploying this
  // recovery fix preserves already-parked sandboxes as well as newly interrupted runs.
  const candidateStatuses = ['running', 'awaiting_input', 'paused'] as const;
  const sandboxSessions = candidateStatuses.flatMap((status) =>
    podRepo.list({ status }).filter((pod) => pod.executionTarget === 'sandbox' && pod.containerId),
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
      const reason = `Sandbox workspace preservation failed after daemon restart; the sandbox was retained for operator recovery: ${
        err instanceof Error ? err.message : String(err)
      }`;
      logger.error({ err, podId: pod.id }, 'Failed to preserve sandbox pod during reconciliation');
      parkSession(pod, 'failed', reason, podRepo, eventBus);
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
      await deps.preserveWorkspace(pod.id);
      const reason =
        'Sandbox workspace was preserved after daemon restart, but the agent stream cannot be reattached; operator action is required before continuing.';
      logger.warn({ podId: pod.id, containerId }, reason);
      parkSession(pod, 'paused', reason, podRepo, eventBus);
      break;
    }

    case 'stopped': {
      await sandboxContainerManager.start(containerId);
      await deps.preserveWorkspace(pod.id);
      const reason =
        'Suspended sandbox was resumed and its workspace was preserved after daemon restart, but the agent stream cannot be reattached; operator action is required before continuing.';
      logger.warn({ podId: pod.id, containerId }, reason);
      parkSession(pod, 'paused', reason, podRepo, eventBus);
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
    pauseReason:
      status === 'paused'
        ? pod.status === 'paused'
          ? (pod.pauseReason ?? 'manual')
          : 'manual'
        : null,
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
