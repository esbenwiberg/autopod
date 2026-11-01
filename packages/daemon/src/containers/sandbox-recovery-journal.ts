import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { AutopodError } from '@autopod/shared';
import type Database from 'better-sqlite3';

export function recoveryError(message: string, code = 'SANDBOX_RECOVERY_BLOCKED'): never {
  throw new AutopodError(message, code, 409);
}
export function recoveryHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
export interface SandboxRecoveryRequest {
  id: string;
  action: 'start' | 'abandon';
  sandboxId: string;
  expectedGeneration: number;
  expectedResourceKey: string;
  reason: string;
  acknowledgeDataLoss: boolean;
}
export interface SandboxRecoveryReceipt {
  id: string;
  podId: string;
  sandboxId: string;
  resourceKey: string;
  generation: number;
  action: 'start' | 'abandon';
  userId: string;
  reason: string;
  requestHash: string;
  binding: string;
  intentIds: string[];
  createdAt: string;
  completedAt: string | null;
}
export interface SandboxRecoveryJournal {
  get(id: string): SandboxRecoveryReceipt | undefined;
  append(id: string, kind: 'admitted' | 'dispatch' | 'running' | 'deleted' | 'unverified'): void;
  hasDispatched(id: string): boolean;
  list(podId: string): SandboxRecoveryReceipt[];
  admit(input: Omit<SandboxRecoveryReceipt, 'createdAt' | 'completedAt'>): SandboxRecoveryReceipt;
  complete(id: string, proof: 'running' | 'deleted'): void;
  resources(podId: string): Array<{ sandboxId: string; resourceKey: string }>;
  pendingIntents(resourceKey: string): string[];
  assertWakeable(sandboxId: string): void;
  assertAvailable(podId: string): void;
  released(resourceKey: string, intentId: string): boolean;
  checkReleaseScope(sandboxId: string, resourceKey?: string): void;
  permitsRelease(resourceKey: string): boolean;
  withAbandonment<T>(
    id: string,
    assertCurrent: () => void,
    operation: () => Promise<T>,
  ): Promise<T>;
}
const scopes = new WeakMap<Database.Database, AsyncLocalStorage<() => string>>();
export function createSandboxRecoveryJournal(db: Database.Database): SandboxRecoveryJournal {
  let scope = scopes.get(db);
  if (!scope) {
    scope = new AsyncLocalStorage<() => string>();
    scopes.set(db, scope);
  }
  const fields = `id,pod_id AS podId,sandbox_id AS sandboxId,resource_key AS resourceKey,
    generation,action,user_id AS userId,reason,request_hash AS requestHash,binding,
    intent_ids AS intentIds,created_at AS createdAt,completed_at AS completedAt`;
  type Row = Omit<SandboxRecoveryReceipt, 'intentIds'> & { intentIds: string };
  const decode = (row: Row): SandboxRecoveryReceipt => ({
    ...row,
    intentIds: JSON.parse(row.intentIds) as string[],
  });
  const get = (id: string) => {
    const row = db.prepare(`SELECT ${fields} FROM sandbox_recovery_requests WHERE id=?`).get(id) as
      | Row
      | undefined;
    return row ? decode(row) : undefined;
  };
  const append = (
    id: string,
    kind: 'admitted' | 'dispatch' | 'running' | 'deleted' | 'unverified',
  ) => {
    db.prepare(
      'INSERT INTO sandbox_recovery_events(request_id,kind,recorded_at) VALUES(?,?,?)',
    ).run(id, kind, new Date().toISOString());
  };
  return {
    get,
    append,
    hasDispatched(id: string): boolean {
      return Boolean(
        db
          .prepare("SELECT 1 FROM sandbox_recovery_events WHERE request_id=? AND kind='dispatch'")
          .get(id),
      );
    },
    list(podId: string): SandboxRecoveryReceipt[] {
      return (
        db
          .prepare(
            `SELECT ${fields} FROM sandbox_recovery_requests WHERE pod_id=? ORDER BY created_at`,
          )
          .all(podId) as Row[]
      ).map(decode);
    },
    admit: db.transaction((input: Omit<SandboxRecoveryReceipt, 'createdAt' | 'completedAt'>) => {
      const existing = get(input.id);
      if (existing) {
        if (existing.requestHash !== input.requestHash)
          recoveryError(
            'Request ID belongs to a different recovery decision.',
            'SANDBOX_RECOVERY_CONFLICT',
          );
        return existing;
      }
      if (
        db
          .prepare(
            "SELECT 1 FROM sandbox_recovery_requests WHERE resource_key=? AND action='abandon' AND binding=? AND user_id=?",
          )
          .get(input.resourceKey, input.binding, input.userId)
      )
        recoveryError(
          'This resource already has an abandonment decision. Refresh and continue that exact request.',
          'SANDBOX_RECOVERY_CONFLICT',
        );
      db.prepare(`INSERT INTO sandbox_recovery_requests
        (id,pod_id,sandbox_id,resource_key,generation,action,user_id,reason,request_hash,binding,intent_ids,created_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        input.id,
        input.podId,
        input.sandboxId,
        input.resourceKey,
        input.generation,
        input.action,
        input.userId,
        input.reason,
        input.requestHash,
        input.binding,
        JSON.stringify(input.intentIds),
        new Date().toISOString(),
      );
      append(input.id, 'admitted');
      return get(input.id) ?? recoveryError('Recovery receipt unavailable');
    }),
    complete: db.transaction((id: string, proof: 'running' | 'deleted') => {
      const record = get(id) ?? recoveryError('Recovery decision unavailable');
      if (record.completedAt) return;
      if ((record.action === 'abandon') !== (proof === 'deleted'))
        recoveryError('Wrong recovery completion evidence');
      const ids =
        proof === 'deleted'
          ? (
              db
                .prepare(
                  "SELECT id FROM sandbox_recovery_requests WHERE resource_key=? AND sandbox_id=? AND action='abandon' AND completed_at IS NULL",
                )
                .all(record.resourceKey, record.sandboxId) as { id: string }[]
            ).map((r) => r.id)
          : [id];
      for (const selected of ids) {
        append(selected, proof);
        db.prepare(
          'UPDATE sandbox_recovery_requests SET completed_at=? WHERE id=? AND completed_at IS NULL',
        ).run(new Date().toISOString(), selected);
      }
    }),
    resources(podId: string): Array<{ sandboxId: string; resourceKey: string }> {
      return db
        .prepare(`SELECT DISTINCT sandbox_id AS sandboxId,resource_key AS resourceKey
        FROM sandbox_wakeup_intents WHERE pod_id=? UNION
        SELECT sandbox_id AS sandboxId,resource_key AS resourceKey FROM sandbox_recovery_requests WHERE pod_id=?`)
        .all(podId, podId) as Array<{ sandboxId: string; resourceKey: string }>;
    },
    pendingIntents(resourceKey: string): string[] {
      return (
        db
          .prepare(
            'SELECT id FROM sandbox_wakeup_intents WHERE resource_key=? AND ended_at IS NULL ORDER BY id',
          )
          .all(resourceKey) as { id: string }[]
      ).map((r) => r.id);
    },
    assertWakeable(sandboxId: string) {
      if (
        db
          .prepare(
            "SELECT 1 FROM sandbox_recovery_requests WHERE sandbox_id=? AND action='abandon'",
          )
          .get(sandboxId)
      )
        recoveryError(
          'This sandbox was explicitly abandoned. Starting it or continuing its task is not authorized.',
          'SANDBOX_ABANDONED',
        );
    },
    assertAvailable(podId: string) {
      if (
        db
          .prepare(
            "SELECT 1 FROM sandbox_recovery_requests WHERE pod_id=? AND action='abandon' AND completed_at IS NULL",
          )
          .get(podId)
      )
        recoveryError(
          'Sandbox abandonment is in progress. Reconcile the exact recovery request before other controls.',
          'SANDBOX_ABANDONMENT_PENDING',
        );
    },
    /** Only confirmed resource deletion releases custody; original wakeup rows stay unchanged. */
    released(resourceKey: string, intentId: string): boolean {
      return Boolean(
        db
          .prepare(`SELECT 1 FROM sandbox_recovery_requests r,json_each(r.intent_ids) i
        WHERE r.resource_key=? AND r.action='abandon' AND r.completed_at IS NOT NULL AND i.value=?`)
          .get(resourceKey, intentId),
      );
    },
    checkReleaseScope(sandboxId: string, resourceKey?: string) {
      const key = scope.getStore()?.();
      if (key && resourceKey && key !== resourceKey)
        recoveryError(
          'Abandonment does not authorize a different provider namespace.',
          'STALE_SANDBOX_RECOVERY',
        );
      const pending = db
        .prepare(
          "SELECT resource_key AS resourceKey FROM sandbox_recovery_requests WHERE sandbox_id=? AND action='abandon' AND completed_at IS NULL",
        )
        .all(sandboxId) as { resourceKey: string }[];
      if (pending.some((r) => r.resourceKey !== key))
        recoveryError(
          'Only the exact abandonment owner may delete this sandbox.',
          'SANDBOX_ABANDONMENT_PENDING',
        );
    },
    permitsRelease(resourceKey: string): boolean {
      // Scope calls its owner fence afresh at every transport-side check.
      return scope.getStore()?.() === resourceKey;
    },
    withAbandonment<T>(
      id: string,
      assertCurrent: () => void,
      operation: () => Promise<T>,
    ): Promise<T> {
      const authorize = () => {
        assertCurrent();
        const record = get(id) ?? recoveryError('Abandonment decision unavailable');
        if (record.action !== 'abandon' || record.completedAt)
          recoveryError('Abandonment is not active');
        const pending = db
          .prepare(
            'SELECT id FROM sandbox_wakeup_intents WHERE resource_key=? AND ended_at IS NULL',
          )
          .all(record.resourceKey) as { id: string }[];
        if (pending.some((p) => !record.intentIds.includes(p.id)))
          recoveryError('A new wakeup was admitted after this abandonment decision');
        return record.resourceKey;
      };
      authorize();
      return scope.run(authorize, operation);
    },
  };
}
