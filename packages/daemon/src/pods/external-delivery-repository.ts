import { AutopodError, type ExternalDeliveryReceipt } from '@autopod/shared';
import type Database from 'better-sqlite3';

export function createExternalDeliveryRepository(db: Database.Database) {
  const get = (podId: string): ExternalDeliveryReceipt | null => {
    const row = db
      .prepare(
        'SELECT receipt FROM external_delivery_observations WHERE pod_id=? ORDER BY generation DESC LIMIT 1',
      )
      .get(podId) as { receipt: string } | undefined;
    return row ? (JSON.parse(row.receipt) as ExternalDeliveryReceipt) : null;
  };
  const retains = (sandboxId: string): boolean =>
    Boolean(
      db.prepare('SELECT 1 FROM external_delivery_observations WHERE sandbox_id=?').get(sandboxId),
    );
  return {
    get,
    retains,
    retainedSandboxIds(): string[] {
      return (
        db.prepare('SELECT DISTINCT sandbox_id FROM external_delivery_observations').all() as {
          sandbox_id: string;
        }[]
      ).map((row) => row.sandbox_id);
    },
    assertReleasable(sandboxId: string): void {
      if (retains(sandboxId))
        throw new AutopodError(
          'Original sandbox is retained for pending external-delivery report recovery; deletion is not authorized.',
          'DELIVERY_REPORTS_PENDING',
          409,
        );
    },
    assertDeletable(podId: string): void {
      if (get(podId))
        throw new AutopodError(
          'External delivery is confirmed, but workspace reports remain pending. Retain the pod, worktree and original sandbox until report preservation is verified.',
          'DELIVERY_REPORTS_PENDING',
          409,
        );
    },
    record(receipt: ExternalDeliveryReceipt): void {
      if (!db.inTransaction)
        throw new Error('External delivery must settle atomically with pod completion');
      const current = db
        .prepare(
          'SELECT status,lifecycle_generation,container_id,branch,worktree_path,pr_url,worktree_compromised,last_validation_result,execution_target FROM pods WHERE id=?',
        )
        .get(receipt.podId) as Record<string, unknown> | undefined;
      if (
        !current ||
        current.execution_target !== 'sandbox' ||
        current.status !== 'validated' ||
        current.lifecycle_generation !== receipt.generation ||
        current.container_id !== receipt.retainedSandboxId ||
        current.branch !== receipt.branch ||
        current.worktree_path !== receipt.worktreePath ||
        current.pr_url !== receipt.prUrl ||
        current.worktree_compromised ||
        receipt.actor.type !== 'human' ||
        !receipt.actor.userId.trim() ||
        !receipt.reason.trim() ||
        receipt.reports !== 'pending' ||
        !['running', 'stopped'].includes(receipt.sandboxStatusAtObservation) ||
        !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(receipt.headSha) ||
        !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(receipt.treeSha)
      ) {
        throw new AutopodError(
          'External delivery evidence no longer owns this lifecycle; retain resources.',
          'STALE_EXTERNAL_DELIVERY',
          409,
        );
      }
      const validation = JSON.parse(String(current.last_validation_result)) as {
        overall?: string;
        timestamp?: string;
      } | null;
      if (validation?.overall !== 'pass' || validation.timestamp !== receipt.validationTimestamp)
        throw new AutopodError(
          'External delivery observation cannot waive failed or changed validation.',
          'STALE_EXTERNAL_DELIVERY',
          409,
        );
      db.prepare(
        'INSERT INTO external_delivery_observations (id,pod_id,generation,sandbox_id,receipt) VALUES (?,?,?,?,?)',
      ).run(
        receipt.id,
        receipt.podId,
        receipt.generation,
        receipt.retainedSandboxId,
        JSON.stringify(receipt),
      );
    },
  };
}
export type ExternalDeliveryRepository = ReturnType<typeof createExternalDeliveryRepository>;
