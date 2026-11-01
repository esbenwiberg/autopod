import { randomUUID } from 'node:crypto';
import { AutopodError } from '@autopod/shared';
import type Database from 'better-sqlite3';
import { checkpointDetachedWakeup } from '../pods/retained-checkpoint-repository.js';
import { createSandboxRecoveryJournal } from './sandbox-recovery-journal.js';

export type SandboxWakeupEvidence =
  | { kind: 'response'; status: number; diagnostics: Record<string, string> }
  | { kind: 'transport-error'; errorCode: string };

export interface SandboxWakeupRecord {
  id: string;
  sandboxId: string;
  startedAt: string;
  dispatchStartedAt: string | null;
  endedAt: string | null;
  settledBy: string | null;
  evidence: Array<{
    recordedAt: string;
    kind: 'response' | 'transport-error';
    status: number | null;
    errorCode: string | null;
    diagnostics: Record<string, string>;
  }>;
}

const diagnosticHeaders = new Set([
  'x-ms-request-id',
  'x-ms-correlation-request-id',
  'request-id',
  'traceparent',
  'retry-after',
]);

export interface SandboxWakeupJournal {
  recovery: ReturnType<typeof createSandboxRecoveryJournal>;
  /** Fresh provider Running only; neither suspension nor a caller assertion qualifies. */
  observeRunning(resourceKey: string, sandboxId: string): void;
  /** Commit before transport. An existing intent permits observation, never another POST. */
  claim(resourceKey: string, sandboxId: string, podId?: string): { id: string; acquired: boolean };
  beginDispatch(id: string): void;
  revokeUnsent(id: string): void;
  rejectLocked(id: string): void;
  /** Only a recorded HTTP 429 proves rate-limit rejection; never inferred from Stopped. */
  rejectRateLimited(id: string): void;
  /** Recording an explicit 429 atomically settles its proved rejection. */
  recordEvidence(id: string, evidence: SandboxWakeupEvidence): void;
  /** Bounded read-only history; labels identify custody, not permission to resume. */
  listForPod(podId: string): SandboxWakeupRecord[];
  retains(sandboxId: string): boolean;
  assertReleasable(sandboxId: string): void;
  assertPodReleasable(podId: string): void;
  pendingSandboxIds(): string[];
  pendingDispatchedIntent(resourceKey: string): string | undefined;
}

export function createSandboxWakeupJournal(db: Database.Database): SandboxWakeupJournal {
  const recovery = createSandboxRecoveryJournal(db);
  const held = (column: 'sandbox_id' | 'pod_id', value: string, scoped = false) => {
    const rows = db
      .prepare(`SELECT id,resource_key AS resourceKey FROM sandbox_wakeup_intents
      WHERE ${column}=? AND ended_at IS NULL`)
      .all(value) as { id: string; resourceKey: string }[];
    return rows.some(
      (r) =>
        !recovery.released(r.resourceKey, r.id) &&
        !(column === 'pod_id' && checkpointDetachedWakeup(db, value, r.resourceKey)) &&
        !(scoped && recovery.permitsRelease(r.resourceKey)),
    );
  };
  const pending = (resourceKey: string) =>
    db
      .prepare('SELECT id FROM sandbox_wakeup_intents WHERE resource_key=? AND ended_at IS NULL')
      .get(resourceKey) as { id: string } | undefined;
  const settle = (id: string, proof: 'observed-running' | 'resource-locked' | 'rate-limited') => {
    db.prepare(`UPDATE sandbox_wakeup_intents SET ended_at=?,settled_by=?
      WHERE id=? AND ended_at IS NULL`).run(new Date().toISOString(), proof, id);
  };
  return {
    recovery,
    pendingDispatchedIntent(resourceKey) {
      return (
        db
          .prepare(`SELECT id FROM sandbox_wakeup_intents
        WHERE resource_key=? AND ended_at IS NULL AND dispatch_started_at IS NOT NULL`)
          .get(resourceKey) as { id: string } | undefined
      )?.id;
    },
    observeRunning: db.transaction((resourceKey: string, sandboxId: string) => {
      db.prepare(`INSERT OR IGNORE INTO sandbox_wakeup_baselines
        (resource_key,sandbox_id,observed_at) VALUES(?,?,?)`).run(
        resourceKey,
        sandboxId,
        new Date().toISOString(),
      );
      const baseline = db
        .prepare('SELECT sandbox_id FROM sandbox_wakeup_baselines WHERE resource_key=?')
        .get(resourceKey) as { sandbox_id: string };
      if (baseline.sandbox_id !== sandboxId)
        throw new AutopodError(
          'Wakeup resource binding changed; retaining the original intent.',
          'SANDBOX_WAKEUP_BINDING_CHANGED',
          409,
        );
      const intent = pending(resourceKey);
      if (intent) settle(intent.id, 'observed-running');
    }),
    claim: db.transaction((resourceKey: string, sandboxId: string, podId?: string) => {
      recovery.assertWakeable(sandboxId);
      const existing = pending(resourceKey);
      if (existing) return { id: existing.id, acquired: false };
      const baseline = db
        .prepare('SELECT sandbox_id FROM sandbox_wakeup_baselines WHERE resource_key=?')
        .get(resourceKey) as { sandbox_id: string } | undefined;
      if (baseline?.sandbox_id !== sandboxId)
        throw new AutopodError(
          'No journaled Running baseline exists for this exact provider resource. A pre-journal stopped sandbox may have an outcome-unknown restore; retain it and reconcile provider evidence rather than submitting another resume.',
          'SANDBOX_WAKEUP_LEGACY_UNVERIFIED',
          409,
        );
      const id = randomUUID();
      db.prepare(`INSERT INTO sandbox_wakeup_intents
        (id,resource_key,sandbox_id,pod_id,started_at) VALUES(?,?,?,?,?)`).run(
        id,
        resourceKey,
        sandboxId,
        podId ?? null,
        new Date().toISOString(),
      );
      return { id, acquired: true };
    }),
    beginDispatch(id) {
      const changed = db
        .prepare(`UPDATE sandbox_wakeup_intents SET dispatch_started_at=?
        WHERE id=? AND ended_at IS NULL AND dispatch_started_at IS NULL`)
        .run(new Date().toISOString(), id);
      if (changed.changes !== 1)
        throw new AutopodError(
          'Wakeup was already reconciled; refresh provider state without dispatching again.',
          'SANDBOX_WAKEUP_SUPERSEDED',
          409,
        );
    },
    revokeUnsent(id) {
      db.prepare(`UPDATE sandbox_wakeup_intents SET ended_at=?,settled_by='dispatch-revoked'
        WHERE id=? AND ended_at IS NULL AND dispatch_started_at IS NULL`).run(
        new Date().toISOString(),
        id,
      );
    },
    rejectLocked(id) {
      settle(id, 'resource-locked');
    },
    rejectRateLimited(id) {
      settle(id, 'rate-limited');
    },
    recordEvidence: db.transaction((id: string, evidence: SandboxWakeupEvidence) => {
      const diagnostics: Record<string, string> = {};
      if (evidence.kind === 'response') {
        for (const [name, value] of Object.entries(evidence.diagnostics)) {
          if (diagnosticHeaders.has(name)) diagnostics[name] = value.slice(0, 256);
        }
      }
      // Late transport cannot append to a settled intent or reinterpret its receipt.
      db.prepare(`INSERT INTO sandbox_wakeup_evidence
        (intent_id,recorded_at,kind,status,error_code,diagnostics_json)
        SELECT id,?,?,?,?,? FROM sandbox_wakeup_intents
        WHERE id=? AND ended_at IS NULL AND dispatch_started_at IS NOT NULL`).run(
        new Date().toISOString(),
        evidence.kind,
        evidence.kind === 'response' ? evidence.status : null,
        evidence.kind === 'transport-error' ? evidence.errorCode.slice(0, 128) : null,
        JSON.stringify(diagnostics),
        id,
      );
      if (evidence.kind === 'response' && evidence.status === 429) settle(id, 'rate-limited');
    }),
    listForPod(podId) {
      const intents = db
        .prepare(`SELECT id,sandbox_id AS sandboxId,started_at AS startedAt,
        dispatch_started_at AS dispatchStartedAt,ended_at AS endedAt,settled_by AS settledBy
        FROM sandbox_wakeup_intents WHERE pod_id=? ORDER BY started_at DESC,id DESC LIMIT 50`)
        .all(podId) as Omit<SandboxWakeupRecord, 'evidence'>[];
      return intents.map((intent) => {
        const rows = db
          .prepare(`SELECT recorded_at AS recordedAt,kind,status,error_code AS errorCode,
          diagnostics_json AS diagnosticsJson FROM sandbox_wakeup_evidence
          WHERE intent_id=? ORDER BY sequence DESC LIMIT 20`)
          .all(intent.id) as Array<{
          recordedAt: string;
          kind: 'response' | 'transport-error';
          status: number | null;
          errorCode: string | null;
          diagnosticsJson: string;
        }>;
        return {
          ...intent,
          evidence: rows.reverse().map(({ diagnosticsJson, ...row }) => ({
            ...row,
            diagnostics: JSON.parse(diagnosticsJson) as Record<string, string>,
          })),
        };
      });
    },
    retains(sandboxId) {
      return held('sandbox_id', sandboxId);
    },
    assertReleasable(sandboxId) {
      recovery.checkReleaseScope(sandboxId);
      if (held('sandbox_id', sandboxId, true))
        throw new AutopodError(
          'An admitted sandbox resume remains outcome-unknown. Retain the original resource and source; observe provider Running before any release or cleanup.',
          'SANDBOX_WAKEUP_OUTCOME_UNVERIFIED',
          409,
        );
    },
    assertPodReleasable(podId) {
      recovery.assertAvailable(podId);
      if (held('pod_id', podId))
        throw new AutopodError(
          'An original resource labelled for this pod has an unresolved wakeup. Clearing its current container pointer does not release source or recovery evidence.',
          'SANDBOX_WAKEUP_OUTCOME_UNVERIFIED',
          409,
        );
    },
    pendingSandboxIds() {
      return (
        db
          .prepare('SELECT DISTINCT sandbox_id FROM sandbox_wakeup_intents WHERE ended_at IS NULL')
          .all() as { sandbox_id: string }[]
      )
        .map((row) => row.sandbox_id)
        .filter((id) => held('sandbox_id', id));
    },
  };
}
