import { createHash, randomUUID } from 'node:crypto';
import { AutopodError, type Pod } from '@autopod/shared';
import type Database from 'better-sqlite3';
import type { BranchPublicationReceipt } from '../interfaces/worktree-manager.js';
import { hasUnansweredDecision } from './decision-admission.js';

export type PublicationSource = Omit<
  BranchPublicationReceipt,
  'observedAt' | 'observedRemoteCommitSha'
>;
export interface FixSourceHandoff {
  publicationId: string;
  priorMergeIntentId: string;
  fixPodId: string;
  fixGeneration: number;
  worktreePath: string;
  source: PublicationSource;
  confirmed: boolean;
}
export interface FixSourceRecovery {
  actor: string;
  reason: string;
  sourcePath: string;
  evidence: string;
}
export interface SourcePublicationLedger {
  admit(pod: Pod, source: PublicationSource): string;
  admitFix(
    parent: Pod,
    fix: Pod,
    source: PublicationSource,
    priorMergeIntentId: string,
    recovery?: FixSourceRecovery,
  ): string;
  fixForMerge(parent: Pod): FixSourceHandoff | null;
  confirm(pod: Pod, id: string, receipt: BranchPublicationReceipt): void;
  confirmedForMerge(publicationPod: Pod, currentPod: Pod, id: string): BranchPublicationReceipt;
  get(
    id: string,
  ): { state: 'admitted' | 'confirmed'; receipt: BranchPublicationReceipt | null } | null;
}
function requireEvidence(condition: boolean): asserts condition {
  if (!condition)
    throw new AutopodError(
      'Source publication evidence requires reconciliation; original resources must be retained.',
      'SOURCE_PUBLICATION_RECONCILIATION_REQUIRED',
      409,
    );
}
function sourceIdentity(source: PublicationSource): string {
  const sha = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
  requireEvidence(
    sha.test(source.commitSha) &&
      sha.test(source.treeSha) &&
      source.worktreeClean === true &&
      source.remoteRef === `refs/heads/${source.branch}` &&
      source.branch.length > 0 &&
      source.branch.length <= 1024,
  );
  const url = new URL(source.repository);
  requireEvidence(
    ['http:', 'https:', 'ssh:', 'file:'].includes(url.protocol) &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      source.repository.length <= 4096,
  );
  return JSON.stringify([
    source.repository,
    source.branch,
    source.remoteRef,
    source.commitSha,
    source.treeSha,
  ]);
}
export function createSourcePublicationLedger(db: Database.Database): SourcePublicationLedger {
  function assertCurrent(pod: Pod, allowCompletedFix = false) {
    const row = db
      .prepare(
        'SELECT lifecycle_generation AS generation, status, profile_name AS profile, branch, base_branch AS baseBranch, worktree_path AS worktree, container_id AS container, agent_mode AS agentMode, output_target AS output, execution_target AS executionTarget, pr_url AS prUrl FROM pods WHERE id = ?',
      )
      .get(pod.id) as
      | {
          generation: number;
          status: string;
          profile: string;
          branch: string;
          baseBranch: string | null;
          worktree: string | null;
          container: string | null;
          agentMode: string;
          output: string;
          executionTarget: string;
          prUrl: string | null;
        }
      | undefined;
    requireEvidence(
      Boolean(
        row &&
          row.generation === pod.lifecycleGeneration &&
          row.status === pod.status &&
          row.profile === pod.profileName &&
          row.branch === pod.branch &&
          row.baseBranch === pod.baseBranch &&
          row.worktree === pod.worktreePath &&
          row.container === pod.containerId &&
          row.agentMode === pod.options.agentMode &&
          row.output === pod.options.output &&
          row.executionTarget === pod.executionTarget &&
          row.prUrl === pod.prUrl,
      ),
    );
    requireEvidence(
      (['validated', 'merging', 'merge_pending', 'running'].includes(pod.status) ||
        (allowCompletedFix && pod.status === 'complete')) &&
        !hasUnansweredDecision(db, pod.id),
    );
  }
  function identity(pod: Pod, source: PublicationSource): string {
    requireEvidence(source.branch === pod.branch && Boolean(pod.worktreePath));
    return createHash('sha256')
      .update(
        JSON.stringify([
          pod.id,
          pod.lifecycleGeneration,
          pod.profileName,
          pod.executionTarget,
          pod.prUrl,
          pod.baseBranch,
          pod.worktreePath,
          pod.containerId,
          pod.options.agentMode,
          pod.options.output,
          sourceIdentity(source),
        ]),
      )
      .digest('hex');
  }
  const ledger: SourcePublicationLedger = {
    admitFix(parent, fix, source, priorMergeIntentId, recovery) {
      requireEvidence(!db.inTransaction);
      const check = () => {
        assertCurrent(parent);
        assertCurrent(fix, Boolean(recovery));
        const owner = db
          .prepare('SELECT fix_pod_id AS fixId FROM pods WHERE id = ?')
          .get(parent.id) as { fixId: string | null };
        const child = db
          .prepare('SELECT linked_pod_id AS parentId FROM pods WHERE id = ?')
          .get(fix.id) as { parentId: string | null };
        const intent = db
          .prepare(
            'SELECT request FROM merge_intents WHERE id = ? AND pod_id = ? AND generation = ?',
          )
          .get(priorMergeIntentId, parent.id, parent.lifecycleGeneration) as
          | { request: string }
          | undefined;
        requireEvidence(Boolean(intent));
        const baseBranch = (
          JSON.parse(intent?.request ?? '{}') as {
            config?: { expectedTarget?: { baseBranch?: string } };
          }
        ).config?.expectedTarget?.baseBranch;
        requireEvidence(typeof baseBranch === 'string' && baseBranch.length > 0);
        requireEvidence(
          parent.status === 'merge_pending' &&
            (fix.status === 'validated' || (Boolean(recovery) && fix.status === 'complete')) &&
            owner.fixId === fix.id &&
            child.parentId === parent.id &&
            fix.branch === parent.branch &&
            (fix.baseBranch ?? baseBranch) === baseBranch &&
            (parent.baseBranch ?? baseBranch) === baseBranch &&
            fix.prUrl === parent.prUrl &&
            Boolean(recovery?.sourcePath ?? fix.worktreePath) &&
            (!recovery ||
              (recovery.actor.trim().length > 0 &&
                recovery.reason.trim().length >= 20 &&
                recovery.evidence.length > 0 &&
                recovery.evidence.length <= 16384)),
        );
      };
      check();
      // Both records are committed before onPrepared returns and Git can push.
      // A crash between them leaves only an unconfirmed intent, never a receipt.
      const id = ledger.admit(parent, source);
      db.transaction(() => {
        check();
        const previous = db
          .prepare(
            'SELECT fix_id AS fixId, fix_generation AS generation, prior_merge_intent_id AS priorId FROM fix_source_handoffs WHERE publication_id = ?',
          )
          .get(id) as { fixId: string; generation: number; priorId: string } | undefined;
        if (previous) {
          requireEvidence(
            (previous.fixId === fix.id &&
              previous.generation === fix.lifecycleGeneration &&
              previous.priorId === priorMergeIntentId) ||
              // Re-publishing the identical confirmed source does not replace its
              // historical origin (a recycled fix may make no further changes).
              Boolean(
                db.prepare('SELECT 1 FROM source_publication_receipts WHERE intent_id = ?').get(id),
              ),
          );
          return;
        }
        db.prepare(`INSERT INTO fix_source_handoffs
          (publication_id, prior_merge_intent_id, parent_id, parent_generation, fix_id, fix_generation, worktree_path, recovery, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
          id,
          priorMergeIntentId,
          parent.id,
          parent.lifecycleGeneration,
          fix.id,
          fix.lifecycleGeneration,
          recovery?.sourcePath ?? fix.worktreePath,
          recovery ? JSON.stringify(recovery) : null,
          new Date().toISOString(),
        );
      }).immediate();
      return id;
    },
    fixForMerge(parent) {
      assertCurrent(parent);
      const row = db
        .prepare(`SELECT h.publication_id AS publicationId,
        h.prior_merge_intent_id AS priorMergeIntentId, h.fix_id AS fixPodId,
        h.fix_generation AS fixGeneration, h.worktree_path AS worktreePath,
        i.identity, i.source_identity AS source, r.intent_id AS confirmed
        FROM fix_source_handoffs h JOIN source_publication_intents i ON i.id = h.publication_id
        LEFT JOIN source_publication_receipts r ON r.intent_id = i.id
        WHERE h.parent_id = ? AND h.parent_generation = ? ORDER BY h.rowid DESC LIMIT 1`)
        .get(parent.id, parent.lifecycleGeneration) as
        | (Omit<FixSourceHandoff, 'source' | 'confirmed'> & {
            identity: string;
            source: string;
            confirmed: string | null;
          })
        | undefined;
      if (!row) return null;
      const [repository, branch, remoteRef, commitSha, treeSha] = JSON.parse(
        row.source,
      ) as string[];
      const source = {
        repository,
        branch,
        remoteRef,
        commitSha,
        treeSha,
        worktreeClean: true,
      } as PublicationSource;
      requireEvidence(row.identity === identity(parent, source));
      return {
        publicationId: row.publicationId,
        priorMergeIntentId: row.priorMergeIntentId,
        fixPodId: row.fixPodId,
        fixGeneration: row.fixGeneration,
        worktreePath: row.worktreePath,
        source,
        confirmed: Boolean(row.confirmed),
      };
    },
    admit(pod, source) {
      requireEvidence(!db.inTransaction);
      return db
        .transaction(() => {
          assertCurrent(pod);
          const hash = identity(pod, source);
          const previous = db
            .prepare('SELECT id FROM source_publication_intents WHERE identity = ?')
            .get(hash) as { id: string } | undefined;
          if (previous) return previous.id;
          const execution = db
            .prepare('SELECT task_id AS taskId FROM task_executions WHERE pod_id = ?')
            .get(pod.id) as { taskId: string } | undefined;
          requireEvidence(Boolean(execution));
          const id = randomUUID();
          db.prepare(
            'INSERT INTO source_publication_intents (id, identity, pod_id, task_id, generation, source_identity, admitted_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
          ).run(
            id,
            hash,
            pod.id,
            execution?.taskId,
            pod.lifecycleGeneration,
            sourceIdentity(source),
            new Date().toISOString(),
          );
          return id;
        })
        .immediate();
    },
    confirm(pod, id, receipt) {
      requireEvidence(!db.inTransaction);
      db.transaction(() => {
        assertCurrent(pod);
        const admitted = db
          .prepare('SELECT identity FROM source_publication_intents WHERE id = ?')
          .get(id) as { identity: string } | undefined;
        requireEvidence(
          admitted?.identity === identity(pod, receipt) &&
            receipt.observedRemoteCommitSha === receipt.commitSha &&
            Number.isFinite(Date.parse(receipt.observedAt)),
        );
        db.prepare(
          'INSERT OR IGNORE INTO source_publication_receipts (intent_id, receipt, confirmed_at) VALUES (?, ?, ?)',
        ).run(
          id,
          JSON.stringify({
            branch: receipt.branch,
            repository: receipt.repository,
            commitSha: receipt.commitSha,
            treeSha: receipt.treeSha,
            remoteRef: receipt.remoteRef,
            observedRemoteCommitSha: receipt.observedRemoteCommitSha,
            worktreeClean: true,
            observedAt: receipt.observedAt,
          }),
          new Date().toISOString(),
        );
      }).immediate();
    },
    confirmedForMerge(publicationPod, currentPod, id) {
      assertCurrent(currentPod);
      const row = db
        .prepare(
          'SELECT i.identity, r.receipt FROM source_publication_intents i JOIN source_publication_receipts r ON r.intent_id = i.id WHERE i.id = ? AND length(r.receipt) <= 16384',
        )
        .get(id) as { identity: string; receipt: string } | undefined;
      requireEvidence(Boolean(row));
      const receipt = JSON.parse(row?.receipt ?? 'null') as BranchPublicationReceipt;
      requireEvidence(
        (publicationPod.prUrl === null || publicationPod.prUrl === currentPod.prUrl) &&
          row?.identity === identity(publicationPod, receipt) &&
          identity({ ...publicationPod, prUrl: currentPod.prUrl }, receipt) ===
            identity(currentPod, receipt),
      );
      return receipt;
    },
    get(id) {
      const row = db
        .prepare(
          'SELECT r.receipt FROM source_publication_intents i LEFT JOIN source_publication_receipts r ON r.intent_id = i.id WHERE i.id = ?',
        )
        .get(id) as { receipt: string | null } | undefined;
      return row
        ? {
            state: row.receipt ? 'confirmed' : 'admitted',
            receipt: row.receipt ? (JSON.parse(row.receipt) as BranchPublicationReceipt) : null,
          }
        : null;
    },
  };
  return ledger;
}
