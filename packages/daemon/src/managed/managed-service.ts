import { randomUUID } from 'node:crypto';
import {
  type ArtifactOutput,
  type DriverHealth,
  type FollowUpEnvelope,
  MANAGED_PROTOCOL_BUILD,
  type ManagedPodEvent,
  type ManagedPodHandle,
  type ManagedPodRequest,
} from '@autopod/shared';
import type Database from 'better-sqlite3';
import type { ManagedArtifactInputs } from './artifact-inputs.js';
import type { ManagedArtifactPipeline } from './artifact-pipeline.js';
import { canonical } from './canonical.js';
import { type ManagedAdmission, admitManagedRequest, validateManagedRequest } from './grants.js';
import type { ManagedSourceDelivery } from './source-delivery.js';

export interface ManagedRuntimePort {
  /** Must test concrete OS/proxy enforcement, not merely prompt or profile fields. */
  preflight(request: ManagedPodRequest): Promise<void>;
  /** Allocation and worker start are keyed by podId and independently restart-safe. */
  ensure(
    podId: string,
    request: ManagedPodRequest,
    checkpoint: (runtimeRef: string) => void,
    fault?: string,
  ): Promise<{ runtimeRef: string }>;
  observe(
    runtimeRef: string,
  ): Promise<{ state: 'running' | 'stopped' | 'unknown'; consumedTokens: number }>;
  stop(runtimeRef: string): Promise<void>;
  send?(runtimeRef: string, message: FollowUpEnvelope, key: string): Promise<void>;
  cleanup?(runtimeRef: string): Promise<boolean>;
  cleanupUnallocated?(podId: string, request: ManagedPodRequest): Promise<boolean>;
  extractOutput?(runtimeRef: string, staging: string, output: ArtifactOutput): Promise<void>;
}
export interface ManagedPodRow {
  pod_id: string;
  dispatcher_installation_id: string;
  dispatcher_attempt_id: string;
  execution_spec_digest: string;
  request_json: string;
  handle_json: string;
  state: string;
  runtime_ref: string | null;
  revoked: number;
  stop_requested: number;
  observed_exit: number;
  cleanup: string;
  grant_revision: number;
  grant_id: string;
  consumed_tokens: number;
  created_at: number;
}

/** A subordinate execution service: no legacy queue, series, fallback or user notification path. */
export class ManagedPodService {
  artifactPipeline?: ManagedArtifactPipeline;
  inputs?: ManagedArtifactInputs;
  source?: ManagedSourceDelivery;
  onTransition?: (row: ManagedPodRow, key: string, kind: ManagedPodEvent['kind']) => void;
  private readonly starts = new Map<string, Promise<ManagedPodHandle>>();
  constructor(
    readonly db: Database.Database,
    readonly admission: ManagedAdmission,
    readonly runtime: ManagedRuntimePort,
    readonly now: () => number = () => Math.floor(Date.now() / 1000),
    readonly enabled = false,
    readonly runtimeCapabilities: readonly string[] = [],
  ) {}

  health(): DriverHealth {
    return {
      schemaVersion: 1,
      backendId: 'autopod-primary',
      protocol: 'managed-pod-v1',
      build: MANAGED_PROTOCOL_BUILD,
      minimumDispatcherBuild: 1,
      minimumAutoPodBuild: 1,
      capabilities: [
        'managed-pod-v1',
        'external-start-idempotency-v1',
        'managed-attempt-lookup-v1',
        ...(this.artifactPipeline ? ['artifact-export-v1'] : []),
        'effective-grant-v1',
        'request-time-budget-v1',
        'autonomous-expiry-v1',
        'managed-controls-v1',
        'managed-events-v1',
        ...(this.inputs ? ['artifact-input-v1'] : []),
        ...(this.source
          ? ['source-finalize-v1', ...(this.source.drafts ? ['source-draft-pr-v1'] : [])]
          : []),
        ...this.runtimeCapabilities,
      ],
      targets: [...this.admission.targets],
      enabled: this.enabled,
    };
  }
  async preflight(raw: unknown, installation?: string): Promise<ManagedPodRequest> {
    if (!this.enabled) throw new Error('managed-lane-disabled');
    const request = validateManagedRequest(raw);
    admitManagedRequest(request, this.admission, this.now());
    if (request.inputArtifacts.length) {
      if (!this.inputs || !installation) throw new Error('artifact-input-unavailable');
      await this.inputs.check(installation, request);
    }
    if (request.outputs.source.mode !== 'none') {
      if (!this.source || !this.source.verifierIdentities.has(request.validation.verifierPolicy))
        throw new Error('source-verifier-unavailable');
      const binding = this.source.git.binding(request.outputs.source);
      if (
        request.effectiveGrant.scope.repositories.find(
          (repo) => repo.enrollmentId === binding.repository,
        )?.baseRevision !== binding.baseCommit
      )
        throw new Error('source-base-not-granted');
    }
    if (request.outputs.artifacts.mode !== 'none' && !this.artifactPipeline)
      throw new Error('artifact-export-unavailable');
    await this.runtime.preflight(request);
    return request;
  }
  row(installation: string, podId: string): ManagedPodRow {
    const row = this.db
      .prepare('SELECT * FROM managed_pods WHERE pod_id=? AND dispatcher_installation_id=?')
      .get(podId, installation) as ManagedPodRow | undefined;
    if (!row) throw new Error('managed-pod-not-found');
    return row;
  }
  lookup(installation: string, startKey: string): ManagedPodRow | undefined {
    return this.db
      .prepare(
        'SELECT * FROM managed_pods WHERE dispatcher_installation_id=? AND managed_start_key=?',
      )
      .get(installation, startKey) as ManagedPodRow | undefined;
  }
  private assertBinding(row: ManagedPodRow, request: ManagedPodRequest): void {
    if (
      row.execution_spec_digest !== request.executionSpecDigest ||
      row.dispatcher_attempt_id !== request.dispatcherAttemptId
    ) {
      throw new Error('managed-start-conflict');
    }
  }
  async start(installation: string, raw: unknown, fault?: string): Promise<ManagedPodHandle> {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(installation))
      throw new Error('invalid-service-identity');
    const request = validateManagedRequest(raw);
    const prior = this.lookup(installation, request.startKey);
    if (prior) this.assertBinding(prior, request);
    if (prior?.runtime_ref && prior.state !== 'queued')
      return JSON.parse(prior.handle_json) as ManagedPodHandle;
    await this.preflight(request, installation);
    if (fault === 'before-reservation') throw new Error('injected-before-reservation');
    const reserve = this.db.transaction(() => {
      const existing = this.lookup(installation, request.startKey);
      if (existing) {
        this.assertBinding(existing, request);
        return existing;
      }
      const podId = `managed-${randomUUID()}`;
      const grant = request.effectiveGrant;
      const handle: ManagedPodHandle = {
        schemaVersion: 1,
        podId,
        dispatcherInstallationId: installation,
        dispatcherAttemptId: request.dispatcherAttemptId,
        acceptedExecutionSpecDigest: request.executionSpecDigest,
        profileSnapshotDigest: request.profileSnapshot.snapshotDigest,
        grantId: grant.grantId,
        grantRevision: grant.revision,
        effectiveGrantDigest: grant.digest,
        route: request.route,
        createdAt: this.now(),
        initialCursor: '0',
      };
      this.db
        .prepare(`INSERT INTO managed_pods (pod_id,dispatcher_installation_id,dispatcher_attempt_id,managed_start_key,
        execution_spec_digest,profile_snapshot_digest,grant_id,grant_revision,effective_grant_digest,request_json,handle_json,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(
          podId,
          installation,
          request.dispatcherAttemptId,
          request.startKey,
          request.executionSpecDigest,
          request.profileSnapshot.snapshotDigest,
          grant.grantId,
          grant.revision,
          grant.digest,
          canonical(request),
          canonical(handle),
          this.now(),
        );
      const reserved = this.row(installation, podId);
      this.onTransition?.(reserved, 'reserved', 'queued');
      return reserved;
    });
    const row = reserve.immediate();
    if (fault === 'after-reservation' || fault === 'after-pod-row')
      throw new Error(`injected-${fault}`);
    return this.launch(row, request, fault);
  }
  private async launch(
    row: ManagedPodRow,
    request: ManagedPodRequest,
    fault?: string,
  ): Promise<ManagedPodHandle> {
    const existing = this.starts.get(row.pod_id);
    if (existing) return existing;
    const launch = async () => {
      const active = this.row(row.dispatcher_installation_id, row.pod_id);
      this.requireActive(active);
      await this.inputs?.prepare(active, request);
      this.requireActive(this.row(row.dispatcher_installation_id, row.pod_id));
      const result = await this.runtime.ensure(
        row.pod_id,
        request,
        (ref) => {
          if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(ref))
            throw new Error('invalid-runtime-reference');
          this.db
            .prepare(
              'UPDATE managed_pods SET runtime_ref=? WHERE pod_id=? AND (runtime_ref IS NULL OR runtime_ref=?)',
            )
            .run(ref, row.pod_id, ref);
          if (this.row(row.dispatcher_installation_id, row.pod_id).runtime_ref !== ref)
            throw new Error('runtime-binding-conflict');
        },
        fault,
      );
      const current = this.db
        .transaction(() => {
          this.db
            .prepare(
              "UPDATE managed_pods SET runtime_ref=?,state='running' WHERE pod_id=? AND revoked=0",
            )
            .run(result.runtimeRef, row.pod_id);
          const observed = this.row(row.dispatcher_installation_id, row.pod_id);
          this.onTransition?.(observed, 'started', 'running');
          return observed;
        })
        .immediate();
      if (current.revoked || this.expired(current)) {
        await this.runtime.stop(result.runtimeRef);
        throw new Error('grant-inactive');
      }
      if (fault === 'before-response') throw new Error('injected-before-response');
      return JSON.parse(row.handle_json) as ManagedPodHandle;
    };
    const promise = launch();
    this.starts.set(row.pod_id, promise);
    try {
      return await promise;
    } catch (error) {
      // Persist only reviewed categories, never exception text, Git output, or credentials.
      const allowed = new Set([
        'managed-git-operation-failed',
        'managed-workspace-enrollment-mismatch',
        'managed-workspace-dependency-cache-conflict',
        'managed-workspace-dependency-cache-not-ignored',
        'managed-sandbox-enforcement-unavailable',
        'managed-sandbox-create-uncertain',
        'managed-dependency-cache-unavailable',
        'managed-writable-mount-unavailable',
      ]);
      const code =
        error instanceof Error && allowed.has(error.message)
          ? error.message
          : 'managed-launch-unconfirmed';
      this.db
        .prepare(`INSERT INTO managed_results(pod_id,limitations_json) VALUES (?,?)
        ON CONFLICT(pod_id) DO UPDATE SET limitations_json=excluded.limitations_json`)
        .run(row.pod_id, canonical([code]));
      throw error;
    } finally {
      this.starts.delete(row.pod_id);
    }
  }
  async reconcileStart(installation: string, raw: unknown): Promise<ManagedPodHandle | null> {
    const request = validateManagedRequest(raw);
    const row = this.lookup(installation, request.startKey);
    if (!row) return null;
    this.assertBinding(row, request);
    // Terminal reservations remain inspectable after expiry, even if allocation never completed.
    // Recovering their identity must not re-admit or restart the expired grant.
    if (row.observed_exit || (row.runtime_ref && row.state !== 'queued'))
      return JSON.parse(row.handle_json) as ManagedPodHandle;
    return this.start(installation, request);
  }
  expired(row: ManagedPodRow): boolean {
    const grant = (JSON.parse(row.request_json) as ManagedPodRequest).effectiveGrant;
    return (
      grant.budget.expiresAt <= this.now() ||
      row.created_at + grant.budget.maxDurationSeconds <= this.now() ||
      ('maxTokens' in grant.budget && row.consumed_tokens >= grant.budget.maxTokens)
    );
  }
  requireActive(row: ManagedPodRow): void {
    if (row.revoked || row.stop_requested || row.observed_exit || this.expired(row))
      throw new Error('grant-inactive');
  }
  /** AutoPod's own watchdog; no Dispatcher connection is needed. Runtime also has its own expiry guard. */
  async enforceExpiry(): Promise<void> {
    const rows = this.db
      .prepare('SELECT * FROM managed_pods WHERE observed_exit=0')
      .all() as ManagedPodRow[];
    for (const row of rows) {
      if (row.runtime_ref) {
        const observed = await this.runtime.observe(row.runtime_ref);
        this.db
          .prepare('UPDATE managed_pods SET consumed_tokens=max(consumed_tokens,?) WHERE pod_id=?')
          .run(observed.consumedTokens, row.pod_id);
        row.consumed_tokens = Math.max(row.consumed_tokens, observed.consumedTokens);
        if (observed.state === 'stopped') {
          const state =
            row.revoked || row.stop_requested || this.expired(row) ? 'killed' : 'validating';
          this.db
            .transaction(() => {
              this.db
                .prepare('UPDATE managed_pods SET observed_exit=1,state=? WHERE pod_id=?')
                .run(state, row.pod_id);
              this.onTransition?.(row, 'runtime-stopped', state);
            })
            .immediate();
        }
      }
      if (row.revoked || row.stop_requested || this.expired(row)) {
        if (row.runtime_ref) {
          this.db
            .prepare('UPDATE managed_pods SET revoked=1,stop_requested=1 WHERE pod_id=?')
            .run(row.pod_id);
          await this.runtime.stop(row.runtime_ref);
        } else {
          const terminal = this.db
            .transaction(() => {
              this.db
                .prepare(
                  "UPDATE managed_pods SET revoked=1,stop_requested=1,observed_exit=1,state='killed' WHERE pod_id=? AND runtime_ref IS NULL AND observed_exit=0",
                )
                .run(row.pod_id);
              const current = this.row(row.dispatcher_installation_id, row.pod_id);
              if (current.observed_exit)
                this.onTransition?.(current, 'runtime-never-allocated', 'killed');
              return current;
            })
            .immediate();
          row.observed_exit = terminal.observed_exit;
        }
      }
    }
  }
}
