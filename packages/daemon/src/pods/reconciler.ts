import { access } from 'node:fs/promises';
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
  quiesceSandboxAgent: (podId: string) => Promise<void>;
  suspendSandbox: (podId: string) => Promise<void>;
  enqueueSession: (podId: string) => void;
  logger: Logger;
}

const MAX_RESTART_RECOVERIES = 3;

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
  const candidateStatuses = ['provisioning', 'running', 'awaiting_input', 'paused'] as const;
  const sandboxSessions = candidateStatuses.flatMap((status) =>
    podRepo
      .list({ status })
      .filter(
        (pod) =>
          pod.executionTarget === 'sandbox' &&
          (pod.status === 'provisioning' || Boolean(pod.containerId)),
      ),
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
  if (pod.status === 'provisioning') {
    await recoverInterruptedProvisioning(pod, deps);
    return;
  }
  if (!pod.containerId) return;
  const containerId = pod.containerId;

  const status = await sandboxContainerManager.getStatus(containerId);

  switch (status) {
    case 'running':
    case 'stopped': {
      if (status === 'stopped') await sandboxContainerManager.start(containerId);
      // The original streaming exec is no longer observable after daemon restart.
      // Stop that worker before snapshotting so it cannot mutate the workspace while
      // recovery is being prepared. The sandbox itself is retained and suspended.
      await deps.quiesceSandboxAgent(pod.id);
      await deps.preserveWorkspace(pod.id);
      await deps.suspendSandbox(pod.id);
      const reason =
        'Sandbox workspace and session were preserved after daemon restart. The sandbox is suspended and will resume in place when work continues.';
      logger.warn({ podId: pod.id, containerId }, reason);
      parkSession(pod, 'paused', reason, podRepo, eventBus);
      break;
    }

    case 'unknown': {
      // An indeterminate status can be a transient data-plane failure. Keep the
      // sandbox and workspace intact so an operator or a later restart can
      // recover it; only a confirmed stopped state may drive terminal cleanup.
      const reason =
        'Sandbox status is unavailable after daemon restart; retaining the sandbox and parking the pod for recovery.';
      logger.warn({ podId: pod.id, containerId }, reason);
      parkSession(pod, 'paused', reason, podRepo, eventBus);
      break;
    }

    case 'deleted': {
      logger.warn({ podId: pod.id, containerId }, 'Sandbox was deleted, marking pod killed');
      markSessionFailed(pod, podRepo, eventBus, logger);
      break;
    }
  }
}

async function recoverInterruptedProvisioning(
  pod: Pod,
  deps: ReconcilerDependencies,
): Promise<void> {
  const { podRepo, eventBus, enqueueSession, logger } = deps;
  const nextRecoveryCount = (pod.recoveryCount ?? 0) + 1;
  if (nextRecoveryCount > MAX_RESTART_RECOVERIES) {
    const reason = `Sandbox provisioning exceeded the restart recovery limit of ${MAX_RESTART_RECOVERIES}; operator intervention is required.`;
    podRepo.update(pod.id, {
      status: 'failed',
      containerId: null,
      completedAt: new Date().toISOString(),
      failureReason: reason,
      lastCorrectionMessage: reason,
    });
    emitStatusChanged(pod.id, pod.status, 'failed', eventBus);
    logger.warn(
      { podId: pod.id, recoveryCount: pod.recoveryCount },
      'Interrupted sandbox provisioning exceeded restart recovery limit',
    );
    return;
  }

  // `processPod()` does not transition provisioning -> running until setup is
  // complete and just before the agent starts. A pod interrupted here therefore
  // has no agent-authored changes to replay. Preserve a recorded host worktree
  // when it still exists; otherwise restart setup from the pod's original ref.
  let survivingWorktreePath: string | null = null;
  if (pod.worktreePath) {
    try {
      await access(pod.worktreePath);
      survivingWorktreePath = pod.worktreePath;
    } catch {
      logger.warn(
        { podId: pod.id, worktreePath: pod.worktreePath },
        'Interrupted sandbox provisioning worktree is unavailable; restarting setup',
      );
    }
  }

  const reason = survivingWorktreePath
    ? 'Sandbox provisioning was interrupted by a daemon restart; resuming setup with the surviving worktree.'
    : 'Sandbox provisioning was interrupted by a daemon restart before a recoverable worktree was recorded; restarting setup from the original ref.';
  podRepo.update(pod.id, {
    status: 'queued',
    containerId: null,
    worktreePath: survivingWorktreePath,
    recoveryWorktreePath: survivingWorktreePath,
    recoveryCount: nextRecoveryCount,
    validationAttempts: 0,
    lastRecoveryTrigger: 'restart',
    completedAt: null,
    failureReason: null,
    lastCorrectionMessage: reason,
  });
  emitStatusChanged(pod.id, pod.status, 'queued', eventBus);
  enqueueSession(pod.id);
  logger.info(
    { podId: pod.id, worktreePath: survivingWorktreePath, recoveryCount: nextRecoveryCount },
    'Interrupted sandbox provisioning re-queued after daemon restart',
  );
}

function emitStatusChanged(
  podId: string,
  previousStatus: Pod['status'],
  newStatus: Pod['status'],
  eventBus: EventBus,
): void {
  eventBus.emit({
    type: 'pod.status_changed',
    timestamp: new Date().toISOString(),
    podId,
    previousStatus,
    newStatus,
  });
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
    ...(status === 'paused' ? { lastRecoveryTrigger: 'restart' as const } : {}),
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
    const previousStatus = pod.status;
    // Route the interrupted state through killing → killed for terminal cleanup.
    podRepo.update(pod.id, { status: 'killing' });
    podRepo.update(pod.id, {
      status: 'killed',
      completedAt: new Date().toISOString(),
    });

    eventBus.emit({
      type: 'pod.status_changed',
      timestamp: new Date().toISOString(),
      podId: pod.id,
      previousStatus,
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
