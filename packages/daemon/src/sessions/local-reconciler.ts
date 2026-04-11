import { access } from 'node:fs/promises';
import type { Session, SessionStatus } from '@autopod/shared';
import type { Logger } from 'pino';
import type { ContainerManager } from '../interfaces/container-manager.js';
import type { EventBus } from './event-bus.js';
import type { SessionRepository } from './session-repository.js';
import type { ValidationRepository } from './validation-repository.js';

export interface LocalReconcilerDependencies {
  sessionRepo: SessionRepository;
  eventBus: EventBus;
  containerManager: ContainerManager;
  enqueueSession: (sessionId: string) => void;
  validationRepo: ValidationRepository;
  logger: Logger;
}

export interface ReconcileResult {
  recovered: string[];
  killed: string[];
  skipped: string[];
}

/**
 * Reconciles local (Docker) sessions on daemon restart.
 *
 * Instead of blindly killing all orphaned sessions, this reconciler:
 * - Recovers sessions whose worktree still exists on disk (re-queues them)
 * - Kills sessions whose worktree is gone (unrecoverable)
 * - Finishes sessions that were mid-kill
 * - Skips sessions in `queued` (they'll be processed normally)
 */
export async function reconcileLocalSessions(
  deps: LocalReconcilerDependencies,
): Promise<ReconcileResult> {
  const { sessionRepo, logger } = deps;
  const result: ReconcileResult = { recovered: [], killed: [], skipped: [] };

  const orphanStatuses = [
    'running',
    'provisioning',
    'queued',
    'awaiting_input',
    'validating',
    'paused',
    'killing',
  ] as const;

  for (const status of orphanStatuses) {
    const sessions = sessionRepo.list({ status });
    const localSessions = sessions.filter((s) => s.executionTarget === 'local');

    for (const session of localSessions) {
      try {
        await reconcileSession(session, deps, result);
      } catch (err) {
        logger.error({ err, sessionId: session.id }, 'Failed to reconcile local session');
        markSessionKilled(session, deps);
        result.killed.push(session.id);
      }
    }
  }

  return result;
}

async function reconcileSession(
  session: Session,
  deps: LocalReconcilerDependencies,
  result: ReconcileResult,
): Promise<void> {
  const { sessionRepo, eventBus, logger } = deps;

  // 1. Sessions already in `killing` → finish the kill
  if (session.status === 'killing') {
    logger.info({ sessionId: session.id }, 'Finishing kill for session stuck in killing state');
    sessionRepo.update(session.id, {
      status: 'killed',
      completedAt: new Date().toISOString(),
    });
    emitStatusChanged(session.id, 'killing', 'killed', eventBus);
    emitCompleted(session, 'killed', eventBus);
    result.killed.push(session.id);
    return;
  }

  // 2. Sessions in `queued` → leave alone, they'll be processed normally
  if (session.status === 'queued') {
    logger.debug({ sessionId: session.id }, 'Skipping queued session — will be processed normally');
    result.skipped.push(session.id);
    return;
  }

  // 3. Sessions with a worktree that still exists → recover
  if (session.worktreePath && (await pathExists(session.worktreePath))) {
    await recoverSession(session, deps, result);
    return;
  }

  // 4. Sessions whose worktree is gone → kill (unrecoverable)
  logger.warn(
    { sessionId: session.id, worktreePath: session.worktreePath },
    'Worktree missing — killing unrecoverable session',
  );
  markSessionKilled(session, deps);
  result.killed.push(session.id);
}

async function recoverSession(
  session: Session,
  deps: LocalReconcilerDependencies,
  result: ReconcileResult,
): Promise<void> {
  const { sessionRepo, eventBus, containerManager, enqueueSession, logger } = deps;

  // If the session was mid-validation when the daemon crashed and validation had already
  // passed (result persisted in DB) + the PR was already created, recover directly to
  // `validated` — no need to re-run the agent or re-run validation.
  if (session.status === 'validating' && session.prUrl) {
    const stored = deps.validationRepo.getForSession(session.id);
    const lastResult = stored[stored.length - 1];
    if (lastResult?.result.overall === 'pass') {
      if (session.containerId) {
        try {
          await containerManager.kill(session.containerId);
        } catch {
          // Container already gone — expected after a crash/restart
        }
      }
      sessionRepo.update(session.id, { status: 'validated', containerId: null });
      emitStatusChanged(session.id, 'validating', 'validated', eventBus);
      logger.info(
        { sessionId: session.id, prUrl: session.prUrl },
        'Session recovered — validation already passed, skipping re-validation',
      );
      result.recovered.push(session.id);
      return;
    }
  }

  // Kill the old container (best-effort — it may already be gone after daemon restart)
  if (session.containerId) {
    try {
      await containerManager.kill(session.containerId);
    } catch {
      // Container already gone — expected after a crash/restart
    }
  }

  // Bypass the state machine for recovery: direct update to `queued`.
  //
  // Why bypass? The normal state machine doesn't allow transitions like
  // running → queued or validating → queued. This is a crash recovery path,
  // not normal flow. The session will get a fresh container with the
  // surviving worktree bind-mounted, so all file state is preserved.
  const previousStatus = session.status;
  sessionRepo.update(session.id, {
    status: 'queued',
    containerId: null,
    recoveryWorktreePath: session.worktreePath,
  });

  emitStatusChanged(session.id, previousStatus, 'queued', eventBus);
  enqueueSession(session.id);

  logger.info(
    { sessionId: session.id, worktreePath: session.worktreePath, previousStatus },
    'Session recovered — re-queued with surviving worktree',
  );
  result.recovered.push(session.id);
}

function markSessionKilled(session: Session, deps: LocalReconcilerDependencies): void {
  const { sessionRepo, eventBus, logger } = deps;
  try {
    const previousStatus = session.status;

    // Transition through killing → killed to keep the audit trail clean
    if (previousStatus !== 'killing') {
      sessionRepo.update(session.id, { status: 'killing' });
    }
    sessionRepo.update(session.id, {
      status: 'killed',
      completedAt: new Date().toISOString(),
    });

    emitStatusChanged(session.id, previousStatus, 'killed', eventBus);
    emitCompleted(session, 'killed', eventBus);

    logger.info({ sessionId: session.id }, 'Local session marked as killed after reconciliation');
  } catch (err) {
    logger.error({ err, sessionId: session.id }, 'Failed to mark local session as killed');
  }
}

function emitStatusChanged(
  sessionId: string,
  previousStatus: SessionStatus,
  newStatus: SessionStatus,
  eventBus: EventBus,
): void {
  eventBus.emit({
    type: 'session.status_changed',
    timestamp: new Date().toISOString(),
    sessionId,
    previousStatus,
    newStatus,
  });
}

function emitCompleted(session: Session, finalStatus: 'killed', eventBus: EventBus): void {
  eventBus.emit({
    type: 'session.completed',
    timestamp: new Date().toISOString(),
    sessionId: session.id,
    finalStatus,
    summary: {
      id: session.id,
      profileName: session.profileName,
      task: session.task,
      status: finalStatus,
      model: session.model,
      runtime: session.runtime,
      duration: session.startedAt ? Date.now() - new Date(session.startedAt).getTime() : null,
      filesChanged: session.filesChanged,
      createdAt: session.createdAt,
    },
  });
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
