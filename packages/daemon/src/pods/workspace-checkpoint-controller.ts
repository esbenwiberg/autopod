import type { WorkspaceCheckpointResult } from '../worktrees/sandbox-workspace-checkpoint.js';

export type CheckpointReason = 'interval' | 'completion' | 'destructive' | 'reconcile' | 'recovery';

export interface WorkspaceFingerprint {
  head: string;
  tree: string;
  dirty: boolean;
}

export interface CheckpointTelemetry {
  podId: string;
  phase: string;
  reason: CheckpointReason;
  durationMs: number;
  attempts: number;
  bytes?: number;
  chunks?: number;
  semaphoreWaitMs: number;
  azureRequestId?: string;
}

export interface CheckpointRecord {
  podId: string;
  sequence: number;
  fingerprint: WorkspaceFingerprint;
  result: WorkspaceCheckpointResult;
  verifiedAt: string | null;
  attempts: number;
  error: WorkspaceCheckpointResult['error'];
}

export interface CheckpointRecordStore {
  save(record: CheckpointRecord): Promise<void>;
  latest(podId: string): Promise<CheckpointRecord | null>;
  latestVerified(podId: string): Promise<CheckpointRecord | null>;
  incomplete(): Promise<CheckpointRecord[]>;
}

export interface WorkspaceCheckpointControllerDependencies {
  observe(podId: string): Promise<WorkspaceFingerprint>;
  checkpoint(
    podId: string,
    reason: CheckpointReason,
    sequence: number,
  ): Promise<WorkspaceCheckpointResult>;
  records: CheckpointRecordStore;
  now?: () => number;
  random?: () => number;
  sleep?: (ms: number) => Promise<void>;
  emit?: (event: CheckpointTelemetry) => void;
  onDurabilityDegraded?: (podId: string, ageMs: number) => void;
  intervalMs?: number;
  durabilityLeaseMs?: number;
  maxConcurrent?: number;
  retryDelaysMs?: readonly number[];
  /** Resume a host-imported checkpoint without reading the sandbox again. */
  materializeImported?: (record: CheckpointRecord) => Promise<WorkspaceCheckpointResult>;
}

export interface CheckpointDecision {
  checkpointed: boolean;
  degraded: boolean;
  result?: WorkspaceCheckpointResult;
}

/**
 * Serializes Git checkpoint work outside pod-manager. It deliberately coalesces
 * duplicate requests and only retries failures explicitly marked retryable.
 */
export class WorkspaceCheckpointController {
  private readonly inFlight = new Map<string, Promise<CheckpointDecision>>();
  private readonly lastFingerprint = new Map<string, WorkspaceFingerprint>();
  private readonly lastAttemptAt = new Map<string, number>();
  private active = 0;
  private readonly waiters: Array<() => void> = [];
  private readonly sequenceByPod = new Map<string, number>();
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly intervalMs: number;
  private readonly durabilityLeaseMs: number;
  private readonly maxConcurrent: number;
  private readonly retryDelaysMs: readonly number[];

  constructor(private readonly deps: WorkspaceCheckpointControllerDependencies) {
    this.now = deps.now ?? Date.now;
    this.random = deps.random ?? Math.random;
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.intervalMs = deps.intervalMs ?? 30_000;
    this.durabilityLeaseMs = deps.durabilityLeaseMs ?? 120_000;
    this.maxConcurrent = deps.maxConcurrent ?? 2;
    this.retryDelaysMs = deps.retryDelaysMs ?? [250, 1_000, 4_000];
  }

  async poll(podId: string): Promise<CheckpointDecision> {
    const fingerprint = await this.deps.observe(podId);
    const previous = this.lastFingerprint.get(podId);
    const changed =
      fingerprint.dirty &&
      (!previous ||
        previous.head !== fingerprint.head ||
        previous.tree !== fingerprint.tree ||
        !previous.dirty);
    this.lastFingerprint.set(podId, fingerprint);
    const elapsed = this.now() - (this.lastAttemptAt.get(podId) ?? 0);
    if (!changed || elapsed < this.intervalMs) return this.degradedDecision(podId, fingerprint);
    return this.request(podId, 'interval', fingerprint);
  }

  async request(
    podId: string,
    reason: Exclude<CheckpointReason, 'interval'>,
    fingerprint?: WorkspaceFingerprint,
  ): Promise<CheckpointDecision> {
    return this.run(podId, reason, fingerprint ?? (await this.deps.observe(podId)));
  }

  async mayDestroy(podId: string): Promise<boolean> {
    const record = await this.deps.records.latestVerified(podId);
    const age = record?.verifiedAt
      ? this.now() - new Date(record.verifiedAt).getTime()
      : Number.POSITIVE_INFINITY;
    return age <= this.durabilityLeaseMs;
  }

  /** Startup-safe reconciliation: only materialize already host-imported proof. */
  async reconcileIncomplete(): Promise<void> {
    for (const record of await this.deps.records.incomplete()) {
      if (
        !record.result.hostImported ||
        !record.result.lineageVerified ||
        !this.deps.materializeImported
      )
        continue;
      const result = await this.deps.materializeImported(record);
      const verified = result.lineageVerified && result.promoted && result.materialized;
      await this.deps.records.save({
        ...record,
        result,
        error: result.error,
        verifiedAt: verified ? new Date(this.now()).toISOString() : null,
      });
    }
  }

  private async degradedDecision(
    podId: string,
    fingerprint: WorkspaceFingerprint,
  ): Promise<CheckpointDecision> {
    if (!fingerprint.dirty) return { checkpointed: false, degraded: false };
    const record = await this.deps.records.latestVerified(podId);
    const age = record?.verifiedAt
      ? this.now() - new Date(record.verifiedAt).getTime()
      : Number.POSITIVE_INFINITY;
    if (age > this.durabilityLeaseMs) {
      this.deps.onDurabilityDegraded?.(podId, age);
      return { checkpointed: false, degraded: true };
    }
    return { checkpointed: false, degraded: false };
  }

  private run(
    podId: string,
    reason: CheckpointReason,
    fingerprint: WorkspaceFingerprint,
  ): Promise<CheckpointDecision> {
    const current = this.inFlight.get(podId);
    if (current) return current;
    const promise = this.execute(podId, reason, fingerprint).finally(() =>
      this.inFlight.delete(podId),
    );
    this.inFlight.set(podId, promise);
    return promise;
  }

  private async acquire(): Promise<number> {
    const started = this.now();
    if (this.active >= this.maxConcurrent) {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    } else {
      this.active++;
    }
    return this.now() - started;
  }

  private release(): void {
    const next = this.waiters.shift();
    if (next) next();
    else this.active--;
  }

  private async nextSequence(podId: string): Promise<number> {
    const current = this.sequenceByPod.get(podId);
    const previous = current ?? (await this.deps.records.latest(podId))?.sequence ?? 0;
    const next = previous + 1;
    this.sequenceByPod.set(podId, next);
    return next;
  }

  private async execute(
    podId: string,
    reason: CheckpointReason,
    fingerprint: WorkspaceFingerprint,
  ): Promise<CheckpointDecision> {
    const waitMs = await this.acquire();
    const started = this.now();
    this.lastAttemptAt.set(podId, started);
    let attempts = 0;
    let result: WorkspaceCheckpointResult;
    let shouldRetry = true;
    try {
      while (shouldRetry) {
        attempts++;
        result = await this.deps.checkpoint(podId, reason, await this.nextSequence(podId));
        shouldRetry = !!result.error?.retryable && attempts <= this.retryDelaysMs.length;
        if (!shouldRetry) break;
        const base = this.retryDelaysMs[attempts - 1] ?? 0;
        await this.sleep(Math.floor(base * (0.5 + this.random())));
      }
      const verified = result.lineageVerified && result.promoted && result.materialized;
      await this.deps.records.save({
        podId,
        sequence: result.sequence,
        fingerprint,
        result,
        attempts,
        verifiedAt: verified ? new Date(this.now()).toISOString() : null,
        error: result.error,
      });
      this.deps.emit?.({
        podId,
        phase: result.error?.phase ?? 'complete',
        reason,
        durationMs: this.now() - started,
        attempts,
        semaphoreWaitMs: waitMs,
      });
      return { checkpointed: verified, degraded: !verified, result };
    } finally {
      this.release();
    }
  }
}
