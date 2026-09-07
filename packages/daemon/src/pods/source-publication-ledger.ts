import { createHash, randomUUID } from 'node:crypto';
import { AutopodError, type Pod } from '@autopod/shared';
import type Database from 'better-sqlite3';
import type { BranchPublicationReceipt } from '../interfaces/worktree-manager.js';
import { hasUnansweredDecision } from './decision-admission.js';

export type PublicationSource = Omit<
  BranchPublicationReceipt,
  'observedAt' | 'observedRemoteCommitSha'
>;
export interface SourcePublicationLedger {
  admit(pod: Pod, source: PublicationSource): string;
  confirm(pod: Pod, id: string, receipt: BranchPublicationReceipt): void;
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
  function assertCurrent(pod: Pod) {
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
      ['validated', 'merging', 'merge_pending', 'running'].includes(pod.status) &&
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
  return {
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
}
