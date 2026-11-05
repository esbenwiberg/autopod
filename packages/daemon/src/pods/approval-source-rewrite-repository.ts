import { createHash } from 'node:crypto';
import path from 'node:path';
import { AutopodError, type Pod } from '@autopod/shared';
import type Database from 'better-sqlite3';
import type { BranchPublicationReceipt } from '../interfaces/worktree-manager.js';
import { createRetainedCheckpointRepository } from './retained-checkpoint-repository.js';

export const rewriteHash = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function rewriteError(detail: string): never {
  throw new AutopodError(
    `Approval source rewrite requires reconciliation. ${detail} Original source and resources are retained.`,
    'DELIVERY_RECONCILIATION_REQUIRED',
    409,
  );
}
export interface ApprovalRewriteBinding {
  predecessor: BranchPublicationReceipt;
  publicationId: string;
  baseBranch: string;
  baseCommitSha: string;
  prUrl: string;
  worktreePath: string;
  containerId: string | null;
  configurationHash: string;
  validationHash: string;
  root: string;
}
export interface ApprovalRewrite {
  id: string;
  podId: string;
  generation: number;
  binding: ApprovalRewriteBinding;
  prepared?: { worktreePath: string; head: string; tree: string };
  activated?: { generation: number };
  checked?: { head: string; tree: string; validationHash: string };
  aborted?: { reason: string };
  /** Current selection projection; get(id) always returns the unchanged original facts. */
  repairId?: string;
}
/** Append-only facts. Neither a checked candidate nor a failed push changes the original lease. */
export function createApprovalSourceRewriteRepository(db: Database.Database) {
  const get = (id: string): ApprovalRewrite | null => {
    const row = db
      .prepare('SELECT pod_id, generation, binding FROM approval_source_rewrites WHERE id=?')
      .get(id) as { pod_id: string; generation: number; binding: string } | undefined;
    if (!row) return null;
    const result: ApprovalRewrite = {
      id,
      podId: row.pod_id,
      generation: row.generation,
      binding: JSON.parse(row.binding),
    };
    for (const event of db
      .prepare(
        'SELECT kind,evidence FROM approval_source_rewrite_events WHERE rewrite_id=? ORDER BY sequence',
      )
      .all(id) as { kind: 'prepared' | 'activated' | 'checked' | 'aborted'; evidence: string }[])
      Object.assign(result, { [event.kind]: JSON.parse(event.evidence) });
    return result;
  };
  const latest = (pod: Pick<Pod, 'id' | 'lifecycleGeneration'>) => {
    const row = db
      .prepare(`SELECT id FROM approval_source_rewrites r WHERE pod_id=?
        AND NOT EXISTS(SELECT 1 FROM approval_source_rewrite_events e WHERE e.rewrite_id=r.id AND e.kind='aborted')
        ORDER BY rowid DESC LIMIT 1`)
      .get(pod.id) as { id: string } | undefined;
    const record = row ? get(row.id) : null;
    if (!record || record.aborted) return null;
    const repair = createRetainedCheckpointRepository(db).latest(pod.id);
    if (repair?.binding.approvalRewrite?.id === record.id && repair.activated) {
      if (
        repair.activated.generation !== pod.lifecycleGeneration ||
        !repair.prepared ||
        !repair.selected
      )
        rewriteError('Repair selection is inconsistent with the current lifecycle.');
      if (repair.binding.approvalRewrite.evidenceHash !== rewriteHash(record))
        rewriteError('Original rewrite evidence changed after repair admission.');
      // Preserve the immutable predecessor/base/configuration. Only CURRENT source
      // projection changes; no old prepared/checked event becomes a writable slot.
      return {
        ...record,
        repairId: repair.id,
        prepared: {
          worktreePath: repair.prepared.worktree,
          head: repair.selected.head,
          tree: repair.selected.tree,
        },
        activated: repair.activated,
        checked:
          repair.checked?.result.overall === 'pass' &&
          repair.checked.result.taskReview?.status === 'pass' &&
          repair.checked.snapshot &&
          repair.checked.source &&
          !repair.blocked
            ? {
                head: repair.checked.source.head,
                tree: repair.checked.source.tree,
                validationHash: repair.checked.resultHash,
              }
            : undefined,
      };
    }
    return record.generation === pod.lifecycleGeneration ||
      record.activated?.generation === pod.lifecycleGeneration
      ? record
      : null;
  };
  const append = (
    id: string,
    kind: 'prepared' | 'activated' | 'checked' | 'aborted',
    evidence: unknown,
  ) => {
    const row = get(id) ?? rewriteError('Rewrite admission unavailable.');
    if (row[kind] || row.aborted) rewriteError('Rewrite evidence already settled.');
    if (
      (kind === 'activated' && !row.prepared) ||
      (kind === 'checked' && !row.activated) ||
      (kind === 'aborted' && (row.prepared || row.activated))
    )
      rewriteError(
        'Rewrite evidence is out of order; selected source cannot be released by aborting preparation.',
      );
    const data = evidence as Partial<
      NonNullable<ApprovalRewrite['prepared']> &
        NonNullable<ApprovalRewrite['activated']> &
        NonNullable<ApprovalRewrite['checked']>
    > | null;
    const sha = (value: unknown) =>
      typeof value === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value);
    if (!data) rewriteError('Rewrite event evidence is unavailable.');
    if (
      kind === 'prepared' &&
      (!sha(data.head) ||
        !sha(data.tree) ||
        data.worktreePath !== path.join(row.binding.root, 'worktree'))
    )
      rewriteError('Candidate identity or namespace is invalid.');
    if (kind === 'activated') {
      const current = db
        .prepare(
          'SELECT lifecycle_generation,worktree_path,container_id,skip_agent FROM pods WHERE id=?',
        )
        .get(row.podId) as Record<string, unknown>;
      if (
        !db.inTransaction ||
        data.generation !== row.generation + 1 ||
        current?.lifecycle_generation !== data.generation ||
        current?.worktree_path !== row.prepared?.worktreePath ||
        current?.container_id !== null ||
        current?.skip_agent !== 1
      )
        rewriteError('Activation must atomically select the next checks-only lifecycle.');
    }
    if (kind === 'checked') {
      const current = db
        .prepare(
          'SELECT lifecycle_generation,status,worktree_path,last_validation_result,skip_validation FROM pods WHERE id=?',
        )
        .get(row.podId) as Record<string, unknown>;
      const result = current?.last_validation_result
        ? JSON.parse(String(current.last_validation_result))
        : null;
      if (
        !sha(data.head) ||
        data.tree !== row.prepared?.tree ||
        current?.lifecycle_generation !== row.activated?.generation ||
        current?.status !== 'validated' ||
        current?.worktree_path !== row.prepared?.worktreePath ||
        current?.skip_validation ||
        result?.overall !== 'pass' ||
        result?.taskReview?.status !== 'pass' ||
        rewriteHash(result) !== data.validationHash
      )
        rewriteError('Current candidate checks are not certified.');
    }
    db.prepare(
      'INSERT INTO approval_source_rewrite_events(rewrite_id,kind,evidence,created_at) VALUES(?,?,?,?)',
    ).run(id, kind, JSON.stringify(evidence), new Date().toISOString());
  };
  const retainedSandboxIds = () =>
    (
      db
        .prepare(`SELECT DISTINCT json_extract(binding,'$.containerId') AS id FROM approval_source_rewrites r
      WHERE json_extract(binding,'$.containerId') IS NOT NULL
      AND NOT EXISTS(SELECT 1 FROM approval_source_rewrite_events e WHERE e.rewrite_id=r.id AND e.kind='aborted')
      UNION
      SELECT json_extract(d.binding,'$.containerId') AS id FROM validation_dispatches d
      JOIN validation_dispatch_results v ON v.dispatch_id=d.id
      WHERE json_extract(v.result,'$.overall')='fail' AND (
        EXISTS(SELECT 1 FROM approval_source_rewrites r JOIN approval_source_rewrite_events e
          ON e.rewrite_id=r.id AND e.kind='activated'
          WHERE r.pod_id=d.pod_id AND json_extract(e.evidence,'$.generation')=d.generation)
        OR EXISTS(SELECT 1 FROM retained_checkpoint_recoveries r JOIN retained_checkpoint_recovery_events e
          ON e.recovery_id=r.id AND e.kind='activated'
          WHERE r.pod_id=d.pod_id AND json_extract(r.binding,'$.approvalRewrite.id') IS NOT NULL
          AND json_extract(e.evidence,'$.generation')=d.generation))`)
        .all() as { id: string }[]
    ).map((row) => row.id);

  return {
    get,
    has: (podId: string) =>
      Boolean(db.prepare('SELECT 1 FROM approval_source_rewrites WHERE pod_id=?').get(podId)),
    latest,
    append,
    /** Only a chain of independently checked approval rewrites can inherit
     * CURRENT control/delivery from a completed repair. Every hop advances one epoch. */
    isRepairSuccessor(pod: Pick<Pod, 'id' | 'lifecycleGeneration'>, checkedHash?: string) {
      const repair = createRetainedCheckpointRepository(db).latest(pod.id);
      const owner = repair?.binding.approvalRewrite;
      const current = latest(pod);
      if (
        !owner ||
        !repair?.checked?.source ||
        repair.checked.result.overall !== 'pass' ||
        !repair.activated ||
        !repair.prepared ||
        !current ||
        current.id === owner.id
      )
        return false;
      return Boolean(
        db
          .prepare(`WITH RECURSIVE ancestry(generation,worktree,result_hash,head) AS (
        SELECT ?,?,?,?
        UNION ALL
        SELECT json_extract(a.evidence,'$.generation'),json_extract(s.evidence,'$.worktreePath'),
          json_extract(c.evidence,'$.validationHash'),json_extract(c.evidence,'$.head')
        FROM ancestry prior JOIN approval_source_rewrites r ON r.pod_id=? AND r.generation=prior.generation
          AND json_extract(r.binding,'$.worktreePath')=prior.worktree
          AND json_extract(r.binding,'$.validationHash')=prior.result_hash
          AND json_extract(r.binding,'$.predecessor.commitSha')=prior.head
        JOIN approval_source_rewrite_events a ON a.rewrite_id=r.id AND a.kind='activated'
        JOIN approval_source_rewrite_events s ON s.rewrite_id=r.id AND s.kind='prepared'
        JOIN approval_source_rewrite_events c ON c.rewrite_id=r.id AND c.kind='checked'
        WHERE json_extract(a.evidence,'$.generation')=r.generation+1
          AND NOT EXISTS(SELECT 1 FROM approval_source_rewrite_events e WHERE e.rewrite_id=r.id AND e.kind='aborted')
      ) SELECT 1 FROM ancestry prior JOIN approval_source_rewrites r ON r.id=? AND r.generation=prior.generation
        AND json_extract(r.binding,'$.worktreePath')=prior.worktree
        AND json_extract(r.binding,'$.validationHash')=prior.result_hash
        AND json_extract(r.binding,'$.predecessor.commitSha')=prior.head
      JOIN approval_source_rewrite_events a ON a.rewrite_id=r.id AND a.kind='activated'
      JOIN approval_source_rewrite_events s ON s.rewrite_id=r.id AND s.kind='prepared'
      LEFT JOIN approval_source_rewrite_events c ON c.rewrite_id=r.id AND c.kind='checked'
      JOIN pods p ON p.id=r.pod_id
      WHERE json_extract(a.evidence,'$.generation')=r.generation+1
        AND p.lifecycle_generation=? AND p.lifecycle_generation=json_extract(a.evidence,'$.generation')
        AND p.worktree_path=json_extract(s.evidence,'$.worktreePath')
        AND (? IS NULL OR json_extract(c.evidence,'$.validationHash')=?) LIMIT 1`)
          .get(
            repair.activated.generation,
            repair.prepared.worktree,
            repair.checked.resultHash,
            repair.checked.source.head,
            pod.id,
            current.id,
            pod.lifecycleGeneration,
            checkedHash ?? null,
            checkedHash ?? null,
          ),
      );
    },
    retainedSandboxIds,
    retains: (id: string) => retainedSandboxIds().includes(id),
    assertReleasable(id: string) {
      if (retainedSandboxIds().includes(id))
        rewriteError('Original pre-rebase resource remains held for report/source recovery.');
    },
    assertDeletable(podId: string) {
      if (
        db
          .prepare(`SELECT 1 FROM approval_source_rewrites r WHERE pod_id=?
        AND NOT EXISTS(SELECT 1 FROM approval_source_rewrite_events e WHERE e.rewrite_id=r.id AND e.kind='aborted')`)
          .get(podId)
      )
        rewriteError('The original rewrite evidence remains retained.');
    },
    admit(id: string, pod: Pod, binding: ApprovalRewriteBinding) {
      db.transaction(() => {
        const receipt = db
          .prepare('SELECT receipt FROM source_publication_receipts WHERE intent_id=?')
          .get(binding.publicationId) as { receipt: string } | undefined;
        const confirmed = receipt
          ? (JSON.parse(receipt.receipt) as BranchPublicationReceipt)
          : null;
        if (
          !confirmed ||
          confirmed.commitSha !== binding.predecessor.commitSha ||
          confirmed.treeSha !== binding.predecessor.treeSha ||
          confirmed.repository !== binding.predecessor.repository ||
          confirmed.branch !== binding.predecessor.branch
        )
          rewriteError('Confirmed predecessor publication is unavailable.');
        const current = db
          .prepare(
            'SELECT lifecycle_generation,status,worktree_path,container_id,pr_url,branch,base_branch,last_validation_result FROM pods WHERE id=?',
          )
          .get(pod.id) as Record<string, unknown>;
        if (
          !current ||
          current.lifecycle_generation !== pod.lifecycleGeneration ||
          current.status !== 'merging' ||
          current.worktree_path !== binding.worktreePath ||
          current.container_id !== binding.containerId ||
          current.pr_url !== binding.prUrl ||
          current.branch !== binding.predecessor.branch ||
          (current.base_branch ?? binding.baseBranch) !== binding.baseBranch ||
          binding.validationHash !==
            rewriteHash(
              current.last_validation_result
                ? JSON.parse(String(current.last_validation_result))
                : null,
            ) ||
          !/^[a-f0-9]{64}$/.test(binding.configurationHash) ||
          !path.isAbsolute(binding.root) ||
          path.basename(binding.root) !== id ||
          (latest(pod) && !latest(pod)?.checked) ||
          binding.predecessor.branch !== pod.branch ||
          binding.predecessor.observedRemoteCommitSha !== binding.predecessor.commitSha ||
          !binding.publicationId ||
          !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(binding.baseCommitSha)
        )
          rewriteError('Predecessor or lifecycle admission changed.');
        db.prepare(
          'INSERT INTO approval_source_rewrites(id,pod_id,generation,binding,created_at) VALUES(?,?,?,?,?)',
        ).run(
          id,
          pod.id,
          pod.lifecycleGeneration,
          JSON.stringify(binding),
          new Date().toISOString(),
        );
      }).immediate();
    },
    assertDelivery(pod: Pod, allowPrepared = false) {
      const row = latest(pod);
      if (!row) return null;
      if (row.repairId) {
        const repair = createRetainedCheckpointRepository(db).get(row.repairId);
        if (repair?.binding.approvalRewrite?.taskHash !== rewriteHash(pod.task))
          rewriteError('Repair task authority changed.');
      }
      if (
        allowPrepared &&
        row.prepared &&
        !row.activated &&
        row.generation === pod.lifecycleGeneration &&
        row.binding.worktreePath === pod.worktreePath &&
        row.binding.containerId === pod.containerId &&
        row.binding.prUrl === pod.prUrl &&
        row.binding.validationHash === rewriteHash(pod.lastValidationResult)
      )
        return null; // Original source is still selected; execution may activate the saved candidate.
      if (
        !row.checked ||
        !row.prepared ||
        row.activated?.generation !== pod.lifecycleGeneration ||
        pod.worktreePath !== row.prepared.worktreePath ||
        row.binding.prUrl !== pod.prUrl ||
        pod.branch !== row.binding.predecessor.branch ||
        pod.lastValidationResult?.overall !== 'pass' ||
        rewriteHash(pod.lastValidationResult) !== row.checked.validationHash ||
        pod.validationWaiver ||
        (pod.validationOverrides?.length ?? 0) > 0 ||
        pod.skipValidation
      )
        rewriteError(
          `Rewrite ${row.id} has no current source-bound checks. Wait for checks or inspect its retained evidence.`,
        );
      return row;
    },
  };
}
export type ApprovalSourceRewriteRepository = ReturnType<
  typeof createApprovalSourceRewriteRepository
>;
