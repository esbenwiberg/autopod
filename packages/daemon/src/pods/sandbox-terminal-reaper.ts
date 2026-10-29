import type { Logger } from 'pino';
import type { SandboxContainerManager } from '../containers/sandbox-container-manager.js';
import type { PodRepository } from './pod-repository.js';
import { assertValidationExecutionSettled } from './validation-recovery-policy.js';

export interface SandboxTerminalReaperDependencies {
  podRepo: PodRepository;
  sandboxContainerManager: SandboxContainerManager;
  logger: Logger;
  deletionTimeoutMs?: number;
}

/**
 * Converges terminal DB-referenced Azure Sandboxes: the backstop for an inline
 * `cleanupContainer` kill that failed or timed out. Walking from the pod row is
 * what gives us current lifecycle ownership. Failed pods are not automatic
 * deletion candidates: a Git checkpoint does not preserve ignored reports.
 * Retained resources can keep billing until explicit supported recovery/cleanup.
 *
 * By construction it cannot see a sandbox the DB no longer references (deleted
 * pod row, cleared `container_id`, id never persisted). That blind spot belongs
 * to {@link SandboxOrphanReaper}, which walks the platform listing instead.
 */
export class SandboxTerminalReaper {
  private running = false;

  constructor(private readonly deps: SandboxTerminalReaperDependencies) {}

  async runSweep(): Promise<void> {
    if (this.running) {
      this.deps.logger.debug('Sandbox terminal reaper skipped overlapping sweep');
      return;
    }
    this.running = true;
    try {
      const pods = (['complete', 'killed'] as const).flatMap((status) =>
        this.deps.podRepo
          .list({ status })
          .filter((pod) => pod.executionTarget === 'sandbox' && pod.containerId),
      );
      for (const pod of pods) await this.reapPod(pod.id);
    } finally {
      this.running = false;
    }
  }

  private async reapPod(podId: string): Promise<void> {
    const pod = this.deps.podRepo.getOrThrow(podId);
    if (
      pod.executionTarget !== 'sandbox' ||
      !pod.containerId ||
      (pod.status !== 'complete' && pod.status !== 'killed')
    ) {
      return;
    }
    const containerId = pod.containerId;
    if (
      this.deps.podRepo.externalDeliveries?.retains(containerId) ||
      this.deps.podRepo.sandboxWakeups?.retains(containerId) ||
      this.deps.podRepo.sourceAdoptions?.retains(containerId)
    )
      return;
    const generation = pod.lifecycleGeneration;
    const status = pod.status;
    if (this.deps.podRepo.taskExecutions?.hasActiveRun(pod.id)) return;
    try {
      assertValidationExecutionSettled(pod);
    } catch (err) {
      this.deps.logger.warn(
        { err, podId: pod.id, containerId },
        'Retaining sandbox because validation execution termination is unverified',
      );
      return;
    }
    const beforeDelete = this.deps.podRepo.getOrThrow(pod.id);
    if (
      beforeDelete.lifecycleGeneration !== generation ||
      beforeDelete.containerId !== containerId ||
      beforeDelete.executionTarget !== 'sandbox' ||
      beforeDelete.status !== status ||
      beforeDelete.pendingEscalation ||
      this.deps.podRepo.externalDeliveries?.retains(containerId) ||
      this.deps.podRepo.sourceAdoptions?.retains(containerId)
    ) {
      return;
    }
    try {
      const deleted = await this.destroyWithinDeadline(containerId);
      if (!deleted) {
        this.deps.logger.warn(
          { podId: pod.id, containerId },
          'Terminal sandbox deletion timed out; retaining container ID for retry',
        );
        return;
      }
      // Avoid clearing a newly assigned container if an operator revived the pod mid-sweep.
      const current = this.deps.podRepo.getOrThrow(pod.id);
      if (
        current.lifecycleGeneration === generation &&
        current.containerId === containerId &&
        current.executionTarget === 'sandbox' &&
        current.status === status
      ) {
        this.deps.podRepo.update(pod.id, { containerId: null });
      }
      this.deps.logger.info({ podId: pod.id, containerId }, 'Terminal sandbox deletion confirmed');
    } catch (err) {
      this.deps.logger.warn(
        { err, podId: pod.id, containerId },
        'Terminal sandbox deletion failed; retaining container ID for retry',
      );
    }
  }

  private async destroyWithinDeadline(containerId: string): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deletion = this.deps.sandboxContainerManager
      .kill(containerId)
      .then(() => true)
      .finally(() => {
        if (timer) clearTimeout(timer);
      });
    return Promise.race([
      deletion,
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), this.deps.deletionTimeoutMs ?? 15_000);
      }),
    ]);
  }
}
