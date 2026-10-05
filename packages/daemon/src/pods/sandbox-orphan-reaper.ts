import type { Logger } from 'pino';
import type { SandboxDescriptor } from '../containers/sandbox-api-client.js';
import type { SandboxContainerManager } from '../containers/sandbox-container-manager.js';
import type { PodRepository } from './pod-repository.js';

export interface SandboxOrphanReaperDependencies {
  podRepo: PodRepository;
  sandboxContainerManager: SandboxContainerManager;
  logger: Logger;
  /**
   * Minimum age before an unreferenced sandbox is eligible for deletion.
   * A spawn can legitimately run for many minutes (disk-image pull, then a poll
   * to `Running`) before `container_id` is persisted, so this must comfortably
   * exceed the worst-case provisioning time or the reaper will delete sandboxes
   * out from under pods that are still coming up.
   */
  minAgeMs?: number;
  /** Per-sandbox delete deadline. Mirrors the terminal reaper. */
  deletionTimeoutMs?: number;
  /**
   * Hard cap on deletes per sweep. Bounds the damage of a wrong predicate and
   * keeps a large backlog from hammering a rate-limited preview data plane.
   */
  maxDeletesPerSweep?: number;
  /** Test seam. */
  now?: () => number;
}

const DEFAULT_MIN_AGE_MS = 60 * 60 * 1000;
const DEFAULT_DELETION_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_DELETES_PER_SWEEP = 20;

export interface SandboxOrphanSweepResult {
  /** Sandboxes returned by the platform listing. */
  listed: number;
  /** Autopod-owned and referenced by no pod row. */
  orphans: number;
  deleted: number;
  failed: number;
  /** Orphan candidates held back by the per-sweep cap. */
  deferred: number;
  /** Autopod-owned, unreferenced, but too young to be safely attributed. */
  tooYoung: number;
  /** Autopod-owned, unreferenced, and carrying no usable creation timestamp. */
  ageUnknown: number;
  /** Not labelled `managedBy: autopod` — never touched. */
  foreign: number;
}

/**
 * Deletes Azure Sandboxes that no pod row references at all.
 *
 * This is the counterpart to {@link SandboxTerminalReaper}, which walks *from*
 * the DB and therefore cannot see an object the DB has forgotten. Three real
 * leak shapes are invisible to any DB-driven sweep:
 *
 *  1. the pod row was deleted (history retention, operator delete) while the
 *     sandbox survived;
 *  2. `container_id` was cleared — including by a terminal-reap whose delete was
 *     accepted and then failed asynchronously on the platform side;
 *  3. the sandbox id was never persisted (daemon crash between create and the
 *     `container_id` write, or a create path that did not record it).
 *
 * A leaked sandbox keeps billing cold storage indefinitely, so the only reliable
 * detector is the platform's own listing.
 *
 * Two invariants keep this safe to run unattended:
 *
 *  - **Ownership.** Only `managedBy: autopod` sandboxes are ever considered. A
 *    sandbox group is shared infrastructure and can hold objects owned by other
 *    workloads; deleting one of those would destroy someone else's work.
 *  - **Attribution.** A sandbox is deleted only if it is old enough that a
 *    concurrent spawn cannot explain the missing reference, *and* only if its
 *    age is actually known. A sandbox with no creation timestamp is reported,
 *    never deleted — failing closed leaks money, failing open kills live pods.
 */
export class SandboxOrphanReaper {
  private running = false;
  private listingUnsupportedLogged = false;

  constructor(private readonly deps: SandboxOrphanReaperDependencies) {}

  async runSweep(): Promise<SandboxOrphanSweepResult> {
    const empty: SandboxOrphanSweepResult = {
      listed: 0,
      orphans: 0,
      deleted: 0,
      failed: 0,
      deferred: 0,
      tooYoung: 0,
      ageUnknown: 0,
      foreign: 0,
    };
    if (this.running) {
      this.deps.logger.debug('Sandbox orphan reaper skipped overlapping sweep');
      return empty;
    }
    this.running = true;
    try {
      const sandboxes = await this.deps.sandboxContainerManager.listSandboxes();
      if (sandboxes === undefined) {
        if (!this.listingUnsupportedLogged) {
          this.listingUnsupportedLogged = true;
          this.deps.logger.warn(
            'Sandbox client cannot list sandboxes — orphan reaping is disabled; leaked sandboxes will keep billing',
          );
        }
        return empty;
      }

      // Read the claim set *after* the listing. A sandbox that was claimed
      // between the two reads then appears claimed and is left alone; had we
      // read the DB first, that write would be invisible and we would delete a
      // sandbox a pod had just taken ownership of.
      const claimed = new Set(this.deps.podRepo.listReferencedContainerIds());
      const result = { ...empty, listed: sandboxes.length };
      const candidates: SandboxDescriptor[] = [];

      for (const sandbox of sandboxes) {
        if (sandbox.labels.managedBy !== 'autopod') {
          result.foreign++;
          continue;
        }
        if (claimed.has(sandbox.id)) continue;

        const ageMs = this.ageMs(sandbox);
        if (ageMs === undefined) {
          result.ageUnknown++;
          this.deps.logger.warn(
            { sandboxId: sandbox.id, podId: sandbox.labels.podId, createdAt: sandbox.createdAt },
            'Unreferenced autopod sandbox has no usable creation timestamp — retaining it rather than risk deleting a provisioning pod',
          );
          continue;
        }
        if (ageMs < (this.deps.minAgeMs ?? DEFAULT_MIN_AGE_MS)) {
          // Almost certainly a spawn in flight whose container_id is not written yet.
          result.tooYoung++;
          continue;
        }
        candidates.push(sandbox);
      }

      result.orphans = candidates.length;
      const cap = this.deps.maxDeletesPerSweep ?? DEFAULT_MAX_DELETES_PER_SWEEP;
      const batch = candidates.slice(0, cap);
      result.deferred = candidates.length - batch.length;

      for (const sandbox of batch) {
        if (await this.deleteOrphan(sandbox)) result.deleted++;
        else result.failed++;
      }

      if (result.orphans > 0 || result.ageUnknown > 0) {
        this.deps.logger.info(result, 'Sandbox orphan sweep complete');
      } else {
        this.deps.logger.debug(result, 'Sandbox orphan sweep complete');
      }
      return result;
    } finally {
      this.running = false;
    }
  }

  private ageMs(sandbox: SandboxDescriptor): number | undefined {
    if (!sandbox.createdAt) return undefined;
    const createdAt = Date.parse(sandbox.createdAt);
    if (!Number.isFinite(createdAt)) return undefined;
    const now = (this.deps.now ?? Date.now)();
    // A timestamp in the future means clock skew or a shape we do not
    // understand; treat it as unknown rather than as "age 0" or "very old".
    if (createdAt > now) return undefined;
    return now - createdAt;
  }

  private async deleteOrphan(sandbox: SandboxDescriptor): Promise<boolean> {
    const context = {
      sandboxId: sandbox.id,
      podId: sandbox.labels.podId ?? null,
      state: sandbox.state ?? null,
      createdAt: sandbox.createdAt ?? null,
    };
    this.deps.logger.info(context, 'Deleting orphaned autopod sandbox referenced by no pod');
    try {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const deletion = this.deps.sandboxContainerManager
        .kill(sandbox.id)
        .then(() => true)
        .finally(() => {
          if (timer) clearTimeout(timer);
        });
      const deleted = await Promise.race([
        deletion,
        new Promise<false>((resolve) => {
          timer = setTimeout(
            () => resolve(false),
            this.deps.deletionTimeoutMs ?? DEFAULT_DELETION_TIMEOUT_MS,
          );
        }),
      ]);
      if (!deleted) {
        this.deps.logger.warn(context, 'Orphaned sandbox deletion timed out — retrying next sweep');
        return false;
      }
      this.deps.logger.info(context, 'Orphaned sandbox deletion confirmed');
      return true;
    } catch (err) {
      this.deps.logger.warn({ err, ...context }, 'Orphaned sandbox deletion failed');
      return false;
    }
  }
}
