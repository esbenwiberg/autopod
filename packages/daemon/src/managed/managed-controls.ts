import {
  type ControlRequest,
  type ControlResult,
  type EffectiveGrant,
  type FollowUpEnvelope,
  type ManagedPodEvent,
  type ManagedPodHandle,
  type ManagedPodRequest,
  type ManagedPodResult,
  parseManagedRecord,
} from '@autopod/shared';
import { canonical, digest } from './canonical.js';
import { requireSubset } from './grants.js';
import type { ManagedPodRow, ManagedPodService } from './managed-service.js';

export class ManagedControls {
  constructor(readonly service: ManagedPodService) {
    service.onTransition = (row, key, kind) => this.event(row, key, kind);
  }
  event(row: ManagedPodRow, key: string, kind: ManagedPodEvent['kind']): void {
    this.service.db
      .transaction(() => {
        const prior = this.service.db
          .prepare('SELECT sequence FROM managed_events WHERE pod_id=? AND event_key=?')
          .get(row.pod_id, key);
        if (prior) return;
        const result = this.service.db
          .prepare("INSERT INTO managed_events (pod_id,event_key,event_json) VALUES (?,?,'{}')")
          .run(row.pod_id, key);
        const sequence = Number(result.lastInsertRowid);
        const event: ManagedPodEvent = {
          schemaVersion: 1,
          eventId: `${row.pod_id}-${sequence}`,
          podId: row.pod_id,
          dispatcherAttemptId: row.dispatcher_attempt_id,
          cursor: String(sequence),
          kind,
          createdAt: this.service.now(),
          evidence: [],
        };
        this.service.db
          .prepare('UPDATE managed_events SET event_json=? WHERE sequence=?')
          .run(canonical(event), sequence);
      })
      .immediate();
  }
  observe(installation: string, podId: string, cursor: string) {
    if (!/^(0|[1-9][0-9]{0,14})$/.test(cursor)) throw new Error('invalid-managed-cursor');
    const row = this.service.row(installation, podId);
    const events = this.service.db
      .prepare(
        'SELECT event_json FROM managed_events WHERE pod_id=? AND sequence>? ORDER BY sequence LIMIT 100',
      )
      .all(podId, Number(cursor)) as { event_json: string }[];
    const parsed = events.map((value) => JSON.parse(value.event_json) as ManagedPodEvent);
    const artifactRows = this.service.db
      .prepare("SELECT receipt_json FROM artifact_exports WHERE pod_id=? AND status='committed'")
      .all(podId) as { receipt_json: string }[];
    const stored = this.service.db
      .prepare('SELECT * FROM managed_results WHERE pod_id=?')
      .get(podId) as
      | {
          evidence_json: string;
          limitations_json: string;
          candidates_json: string;
          source_json: string;
        }
      | undefined;
    const limitations = stored ? (JSON.parse(stored.limitations_json) as string[]) : [];
    const providerFailure = this.service.db
      .prepare(`SELECT failure_phase,failure_reason,failure_http_status
        FROM managed_provider_requests WHERE pod_id=? AND failure_phase IS NOT NULL
        ORDER BY rowid DESC LIMIT 1`)
      .get(podId) as
      | { failure_phase: string; failure_reason: string; failure_http_status: number | null }
      | undefined;
    if (providerFailure) {
      const status = providerFailure.failure_http_status ?? 'none';
      limitations.push(
        `provider-${providerFailure.failure_phase}-${providerFailure.failure_reason}-${status}`,
      );
    }
    const result: ManagedPodResult = {
      schemaVersion: 1,
      handle: JSON.parse(row.handle_json) as ManagedPodHandle,
      state: row.state as ManagedPodResult['state'],
      artifacts: artifactRows.map((item) => JSON.parse(item.receipt_json)),
      candidates: stored ? JSON.parse(stored.candidates_json) : [],
      source: stored ? JSON.parse(stored.source_json) : [],
      evidence: stored ? JSON.parse(stored.evidence_json) : [],
      limitations: [...new Set(limitations)],
      revoked: Boolean(row.revoked),
      observedExit: Boolean(row.observed_exit),
      cleanup: row.cleanup as ManagedPodResult['cleanup'],
    };
    return { schemaVersion: 1, cursor: parsed.at(-1)?.cursor ?? cursor, events: parsed, result };
  }
  private bind(
    row: ManagedPodRow,
    request: { dispatcherAttemptId: string; grantId: string; grantRevision: number },
  ): void {
    if (
      request.dispatcherAttemptId !== row.dispatcher_attempt_id ||
      request.grantId !== row.grant_id ||
      request.grantRevision !== row.grant_revision
    )
      throw new Error('managed-stale-grant');
  }
  private reserve(
    row: ManagedPodRow,
    key: string,
    request: unknown,
    kind: string,
  ): ControlResult | undefined {
    if (!/^[A-Za-z0-9_-]{1,200}$/.test(key)) throw new Error('invalid-control-key');
    const hash = digest(request);
    const prior = this.service.db
      .prepare(
        'SELECT request_digest,result_json FROM managed_controls WHERE pod_id=? AND operation_key=?',
      )
      .get(row.pod_id, key) as { request_digest: string; result_json: string | null } | undefined;
    if (prior) {
      if (hash !== prior.request_digest) throw new Error('managed-control-conflict');
      return prior.result_json ? (JSON.parse(prior.result_json) as ControlResult) : undefined;
    }
    this.service.db
      .prepare(
        'INSERT INTO managed_controls (pod_id,operation_key,request_digest,kind) VALUES (?,?,?,?)',
      )
      .run(row.pod_id, key, hash, kind);
    return undefined;
  }
  private result(row: ManagedPodRow): ControlResult {
    return {
      schemaVersion: 1,
      accepted: true,
      revoked: Boolean(row.revoked),
      stopRequested: Boolean(row.stop_requested),
      observedExit: Boolean(row.observed_exit),
      cleanup: row.cleanup as ControlResult['cleanup'],
    };
  }
  private artifactExportImpossible(podId: string): boolean {
    const stored = this.service.db
      .prepare('SELECT limitations_json FROM managed_results WHERE pod_id=?')
      .get(podId) as { limitations_json: string } | undefined;
    if (!stored) return false;
    const limitations = JSON.parse(stored.limitations_json) as unknown;
    return (
      Array.isArray(limitations) &&
      limitations.some((value) =>
        ['artifact-export-incomplete', 'agent-runtime-failed'].includes(String(value)),
      )
    );
  }
  async control(
    installation: string,
    podId: string,
    raw: unknown,
    key: string,
  ): Promise<ControlResult> {
    const request: ControlRequest = parseManagedRecord('ControlRequestSchema', raw);
    if (!['revoke', 'stop', 'cleanup'].includes(request.operation))
      throw new Error('managed-control-unavailable');
    const admitted = this.service.db
      .transaction(() => {
        const row = this.service.row(installation, podId);
        this.bind(row, request);
        const prior = this.reserve(row, key, request, request.operation);
        if (prior && (request.operation !== 'cleanup' || row.cleanup === 'observed'))
          return { prior: this.result(row), row };
        if (request.operation === 'cleanup') {
          if (!row.observed_exit) throw new Error('managed-cleanup-before-exit');
          if (
            row.runtime_ref
              ? !this.service.runtime.cleanup
              : !this.service.runtime.cleanupUnallocated
          )
            throw new Error('managed-cleanup-unavailable');
          const spec = JSON.parse(row.request_json) as ManagedPodRequest;
          if (
            row.runtime_ref &&
            spec.outputs.artifacts.mode === 'required' &&
            !this.artifactExportImpossible(podId) &&
            !this.service.db
              .prepare("SELECT 1 FROM artifact_exports WHERE pod_id=? AND status='committed'")
              .get(podId)
          ) {
            throw new Error('managed-artifact-export-pending');
          }
          if (row.runtime_ref && spec.outputs.source.mode !== 'none') {
            if (!this.service.source) throw new Error('managed-source-candidate-pending');
            this.service.source.candidate(installation, podId);
          }
          this.service.db
            .prepare("UPDATE managed_pods SET cleanup='requested' WHERE pod_id=?")
            .run(podId);
        } else {
          // Commit authority withdrawal before any runtime call or acknowledgement.
          this.service.db
            .prepare(
              "UPDATE managed_pods SET revoked=max(revoked,?),stop_requested=1,state='killing' WHERE pod_id=? AND observed_exit=0",
            )
            .run(request.operation === 'revoke' ? 1 : 0, podId);
          this.service.db
            .prepare('UPDATE managed_pods SET stop_requested=1 WHERE pod_id=?')
            .run(podId);
          if (request.operation === 'revoke')
            this.service.db.prepare('UPDATE managed_pods SET revoked=1 WHERE pod_id=?').run(podId);
        }
        const current = this.service.row(installation, podId);
        const result = this.result(current);
        this.service.db
          .prepare('UPDATE managed_controls SET result_json=? WHERE pod_id=? AND operation_key=?')
          .run(canonical(result), podId, key);
        this.event(
          current,
          `control-${key}`,
          request.operation === 'revoke'
            ? 'revoked'
            : request.operation === 'stop'
              ? 'killing'
              : 'cleanup',
        );
        return { row: current, prior: undefined };
      })
      .immediate();
    if (admitted.prior) return admitted.prior;
    const row = admitted.row;
    if (row.runtime_ref) {
      if (request.operation === 'cleanup') {
        const observed = await this.service.runtime.cleanup?.(row.runtime_ref);
        if (observed)
          this.service.db
            .prepare("UPDATE managed_pods SET cleanup='observed' WHERE pod_id=?")
            .run(podId);
      } else {
        // Failure does not undo a durable revocation. The independent watchdog retries.
        await this.service.runtime.stop(row.runtime_ref).catch(() => {});
      }
    }
    if (!row.runtime_ref && row.observed_exit && request.operation === 'cleanup') {
      const removed = await this.service.runtime.cleanupUnallocated?.(
        podId,
        JSON.parse(row.request_json) as ManagedPodRequest,
      );
      if (removed)
        this.service.db
          .prepare("UPDATE managed_pods SET cleanup='observed' WHERE pod_id=?")
          .run(podId);
    }
    return this.result(this.service.row(installation, podId));
  }
  async send(
    installation: string,
    podId: string,
    raw: unknown,
    key: string,
  ): Promise<ControlResult> {
    const message: FollowUpEnvelope = parseManagedRecord('FollowUpEnvelopeSchema', raw);
    const row = this.service.row(installation, podId);
    this.bind(row, message);
    this.service.requireActive(row);
    if (!row.runtime_ref || !this.service.runtime.send)
      throw new Error('managed-follow-up-unavailable');
    const prior = this.service.db
      .transaction(() => this.reserve(row, key, message, 'follow-up'))
      .immediate();
    if (prior) return prior;
    // The gateway also uses key; a crash after delivery but before this commit cannot redeliver.
    await this.service.runtime.send(row.runtime_ref, message, key);
    this.service.requireActive(this.service.row(installation, podId));
    const result = this.result(row);
    this.service.db
      .prepare('UPDATE managed_controls SET result_json=? WHERE pod_id=? AND operation_key=?')
      .run(canonical(result), podId, key);
    this.event(row, `message-${key}`, 'follow-up');
    return result;
  }
  updateGrant(installation: string, podId: string, raw: unknown): void {
    const grant: EffectiveGrant = parseManagedRecord('EffectiveGrantSchema', raw);
    if (
      grant.digest !==
      digest(Object.fromEntries(Object.entries(grant).filter(([key]) => key !== 'digest')))
    )
      throw new Error('grant-digest-mismatch');
    this.service.db
      .transaction(() => {
        const row = this.service.row(installation, podId);
        this.service.requireActive(row);
        const spec = JSON.parse(row.request_json) as ManagedPodRequest;
        if (
          grant.dispatcherAttemptId !== row.dispatcher_attempt_id ||
          grant.grantId !== row.grant_id ||
          grant.revision <= row.grant_revision ||
          grant.profileSnapshotDigest !== spec.profileSnapshot.snapshotDigest ||
          canonical(grant.route) !== canonical(spec.route)
        )
          throw new Error('managed-stale-grant');
        requireSubset(grant.scope, spec.effectiveGrant.scope);
        // Narrowing the OS envelope requires restarting under a new attempt, unless identical.
        if (canonical(grant.scope) !== canonical(spec.effectiveGrant.scope))
          throw new Error('grant-scope-update-requires-new-attempt');
        if (canonical(grant.budget) !== canonical(spec.effectiveGrant.budget))
          throw new Error('grant-budget-update-requires-new-attempt');
        this.service.db
          .prepare(
            'UPDATE managed_pods SET active_grant_json=?,grant_revision=?,effective_grant_digest=? WHERE pod_id=?',
          )
          .run(canonical(grant), grant.revision, grant.digest, podId);
      })
      .immediate();
  }
}
