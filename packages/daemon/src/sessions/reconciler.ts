import type { Session } from '@autopod/shared';
import type { Logger } from 'pino';
import type { AciContainerManager } from '../containers/aci-container-manager.js';
import type { EventBus } from './event-bus.js';
import type { SessionRepository } from './session-repository.js';

export interface ReconcilerDependencies {
  sessionRepo: SessionRepository;
  eventBus: EventBus;
  aciContainerManager: AciContainerManager;
  onReconnected: (sessionId: string, containerId: string) => Promise<void>;
  logger: Logger;
}

/**
 * Reconciles ACI sessions on daemon restart.
 *
 * Finds sessions with status='running' and executionTarget='aci',
 * checks their container state, and either reconnects or marks them failed.
 */
export async function reconcileAciSessions(deps: ReconcilerDependencies): Promise<void> {
  const { sessionRepo, eventBus, logger } = deps;

  // Find all running ACI sessions
  const runningSessions = sessionRepo.list({ status: 'running' });
  const aciSessions = runningSessions.filter((s) => s.executionTarget === 'aci' && s.containerId);

  if (aciSessions.length === 0) {
    logger.info('No ACI sessions to reconcile');
    return;
  }

  logger.info({ count: aciSessions.length }, 'Reconciling ACI sessions');

  for (const session of aciSessions) {
    try {
      await reconcileSession(session, deps);
    } catch (err) {
      logger.error({ err, sessionId: session.id }, 'Failed to reconcile ACI session');
      markSessionFailed(session, sessionRepo, eventBus, logger);
    }
  }
}

async function reconcileSession(session: Session, deps: ReconcilerDependencies): Promise<void> {
  const { aciContainerManager, sessionRepo, eventBus, onReconnected, logger } = deps;
  if (!session.containerId) return;
  const containerId = session.containerId;

  const status = await aciContainerManager.getStatus(containerId);

  switch (status) {
    case 'running': {
      // Container still running — reconnect log stream and resume event consumption
      logger.info(
        { sessionId: session.id, containerId },
        'ACI container still running, reconnecting',
      );
      await onReconnected(session.id, containerId);
      break;
    }

    case 'stopped': {
      // Container finished — trigger completion handling
      logger.info(
        { sessionId: session.id, containerId },
        'ACI container stopped, triggering completion',
      );
      // Mark as completing — the session manager's handleCompletion will take over
      await onReconnected(session.id, containerId);
      break;
    }

    case 'unknown': {
      // Container gone — mark session as failed
      logger.warn(
        { sessionId: session.id, containerId },
        'ACI container not found, marking session failed',
      );
      markSessionFailed(session, sessionRepo, eventBus, logger);
      break;
    }
  }
}

function markSessionFailed(
  session: Session,
  sessionRepo: SessionRepository,
  eventBus: EventBus,
  logger: Logger,
): void {
  try {
    // Transition: running → killing → killed (to respect state machine)
    sessionRepo.update(session.id, { status: 'killing' });
    sessionRepo.update(session.id, {
      status: 'killed',
      completedAt: new Date().toISOString(),
    });

    eventBus.emit({
      type: 'session.status_changed',
      timestamp: new Date().toISOString(),
      sessionId: session.id,
      previousStatus: 'running',
      newStatus: 'killed',
    });

    eventBus.emit({
      type: 'session.completed',
      timestamp: new Date().toISOString(),
      sessionId: session.id,
      finalStatus: 'killed',
      summary: {
        id: session.id,
        profileName: session.profileName,
        task: session.task,
        status: 'killed',
        model: session.model,
        runtime: session.runtime,
        duration: session.startedAt ? Date.now() - new Date(session.startedAt).getTime() : null,
        filesChanged: session.filesChanged,
        createdAt: session.createdAt,
      },
    });

    logger.info({ sessionId: session.id }, 'ACI session marked as killed after reconciliation');
  } catch (err) {
    logger.error({ err, sessionId: session.id }, 'Failed to mark ACI session as failed');
  }
}
