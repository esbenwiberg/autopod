import type { Logger } from 'pino';
import type { SandboxContainerManager } from '../containers/sandbox-container-manager.js';
import type { PodRepository } from './pod-repository.js';

export interface SandboxTerminalReaperDependencies {
  podRepo: PodRepository;
  sandboxContainerManager: SandboxContainerManager;
  /** Must throw unless the failed sandbox's workspace is safely on the host. */
  preserveWorkspace: (podId: string) => Promise<void>;
  logger: Logger;
  deletionTimeoutMs?: number;
}

/**
 * Converges terminal DB-referenced Azure Sandboxes. It deliberately cannot
 * discover Azure-only resources: the preview list contract is not evidenced
 * here, while a pod row gives us both ownership and recovery context.
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
      const pods = (['complete', 'killed', 'failed'] as const).flatMap((status) =>
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
      !(['complete', 'killed', 'failed'] as const).includes(pod.status)
    ) {
      return;
    }
    const containerId = pod.containerId;
    if (pod.status === 'failed') {
      try {
        await this.deps.preserveWorkspace(pod.id);
      } catch (err) {
        this.deps.logger.error(
          { err, podId: pod.id, containerId },
          'Retaining failed sandbox because workspace preservation did not succeed',
        );
        return;
      }
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
      if (current.containerId === containerId && current.executionTarget === 'sandbox') {
        this.deps.podRepo.update(
          pod.id,
          current.status === 'failed'
            ? { containerId: null, worktreeCompromised: false, preSubmitReview: null }
            : { containerId: null },
        );
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
