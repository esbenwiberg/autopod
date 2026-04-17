import { access } from 'node:fs/promises';
import type { Pod, PodStatus } from '@autopod/shared';
import type { Logger } from 'pino';
import type { ContainerManager } from '../interfaces/container-manager.js';
import type { EventBus } from './event-bus.js';
import type { PodRepository } from './pod-repository.js';
import type { ValidationRepository } from './validation-repository.js';

export interface LocalReconcilerDependencies {
  podRepo: PodRepository;
  eventBus: EventBus;
  containerManager: ContainerManager;
  enqueueSession: (podId: string) => void;
  validationRepo: ValidationRepository;
  logger: Logger;
}

export interface ReconcileResult {
  recovered: string[];
  killed: string[];
  skipped: string[];
}

/**
 * Reconciles local (Docker) pods on daemon restart.
 *
 * Instead of blindly killing all orphaned pods, this reconciler:
 * - Recovers pods whose worktree still exists on disk (re-queues them)
 * - Kills pods whose worktree is gone (unrecoverable)
 * - Finishes pods that were mid-kill
 * - Skips pods in `queued` (they'll be processed normally)
 */
export async function reconcileLocalSessions(
  deps: LocalReconcilerDependencies,
): Promise<ReconcileResult> {
  const { podRepo, logger } = deps;
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
    const pods = podRepo.list({ status });
    const localSessions = pods.filter((s) => s.executionTarget === 'local');

    for (const pod of localSessions) {
      try {
        await reconcileSession(pod, deps, result);
      } catch (err) {
        logger.error({ err, podId: pod.id }, 'Failed to reconcile local pod');
        markSessionKilled(pod, deps);
        result.killed.push(pod.id);
      }
    }
  }

  return result;
}

async function reconcileSession(
  pod: Pod,
  deps: LocalReconcilerDependencies,
  result: ReconcileResult,
): Promise<void> {
  const { podRepo, eventBus, logger } = deps;

  // 1. Sessions already in `killing` → finish the kill
  if (pod.status === 'killing') {
    logger.info({ podId: pod.id }, 'Finishing kill for pod stuck in killing state');
    podRepo.update(pod.id, {
      status: 'killed',
      completedAt: new Date().toISOString(),
    });
    emitStatusChanged(pod.id, 'killing', 'killed', eventBus);
    emitCompleted(pod, 'killed', eventBus);
    result.killed.push(pod.id);
    return;
  }

  // 2. Sessions in `queued` → leave alone, they'll be processed normally
  if (pod.status === 'queued') {
    logger.debug({ podId: pod.id }, 'Skipping queued pod — will be processed normally');
    result.skipped.push(pod.id);
    return;
  }

  // 3. Sessions with a worktree that still exists → recover
  if (pod.worktreePath && (await pathExists(pod.worktreePath))) {
    await recoverSession(pod, deps, result);
    return;
  }

  // 4. Sessions whose worktree is gone → kill (unrecoverable)
  logger.warn(
    { podId: pod.id, worktreePath: pod.worktreePath },
    'Worktree missing — killing unrecoverable pod',
  );
  markSessionKilled(pod, deps);
  result.killed.push(pod.id);
}

async function recoverSession(
  pod: Pod,
  deps: LocalReconcilerDependencies,
  result: ReconcileResult,
): Promise<void> {
  const { podRepo, eventBus, containerManager, enqueueSession, logger } = deps;

  // If the pod was mid-validation when the daemon crashed and validation had already
  // passed (result persisted in DB) + the PR was already created, recover directly to
  // `validated` — no need to re-run the agent or re-run validation.
  if (pod.status === 'validating' && pod.prUrl) {
    const stored = deps.validationRepo.getForSession(pod.id);
    const lastResult = stored[stored.length - 1];
    if (lastResult?.result.overall === 'pass') {
      if (pod.containerId) {
        try {
          await containerManager.kill(pod.containerId);
        } catch {
          // Container already gone — expected after a crash/restart
        }
      }
      podRepo.update(pod.id, { status: 'validated', containerId: null });
      emitStatusChanged(pod.id, 'validating', 'validated', eventBus);
      logger.info(
        { podId: pod.id, prUrl: pod.prUrl },
        'Pod recovered — validation already passed, skipping re-validation',
      );
      result.recovered.push(pod.id);
      return;
    }
  }

  // Kill the old container (best-effort — it may already be gone after daemon restart)
  if (pod.containerId) {
    try {
      await containerManager.kill(pod.containerId);
    } catch {
      // Container already gone — expected after a crash/restart
    }
  }

  // Bypass the state machine for recovery: direct update to `queued`.
  //
  // Why bypass? The normal state machine doesn't allow transitions like
  // running → queued or validating → queued. This is a crash recovery path,
  // not normal flow. The pod will get a fresh container with the
  // surviving worktree bind-mounted, so all file state is preserved.
  const previousStatus = pod.status;
  podRepo.update(pod.id, {
    status: 'queued',
    containerId: null,
    recoveryWorktreePath: pod.worktreePath,
  });

  emitStatusChanged(pod.id, previousStatus, 'queued', eventBus);
  enqueueSession(pod.id);

  logger.info(
    { podId: pod.id, worktreePath: pod.worktreePath, previousStatus },
    'Pod recovered — re-queued with surviving worktree',
  );
  result.recovered.push(pod.id);
}

function markSessionKilled(pod: Pod, deps: LocalReconcilerDependencies): void {
  const { podRepo, eventBus, logger } = deps;
  try {
    const previousStatus = pod.status;

    // Transition through killing → killed to keep the audit trail clean
    if (previousStatus !== 'killing') {
      podRepo.update(pod.id, { status: 'killing' });
    }
    podRepo.update(pod.id, {
      status: 'killed',
      completedAt: new Date().toISOString(),
    });

    emitStatusChanged(pod.id, previousStatus, 'killed', eventBus);
    emitCompleted(pod, 'killed', eventBus);

    logger.info({ podId: pod.id }, 'Local pod marked as killed after reconciliation');
  } catch (err) {
    logger.error({ err, podId: pod.id }, 'Failed to mark local pod as killed');
  }
}

function emitStatusChanged(
  podId: string,
  previousStatus: PodStatus,
  newStatus: PodStatus,
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

function emitCompleted(pod: Pod, finalStatus: 'killed', eventBus: EventBus): void {
  eventBus.emit({
    type: 'pod.completed',
    timestamp: new Date().toISOString(),
    podId: pod.id,
    finalStatus,
    summary: {
      id: pod.id,
      profileName: pod.profileName,
      task: pod.task,
      status: finalStatus,
      model: pod.model,
      runtime: pod.runtime,
      duration: pod.startedAt ? Date.now() - new Date(pod.startedAt).getTime() : null,
      filesChanged: pod.filesChanged,
      createdAt: pod.createdAt,
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
