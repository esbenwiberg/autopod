import type { GitHubOperation, GitHubPolicyDecision } from '@autopod/shared';
import type Database from 'better-sqlite3';
import { configurationError } from '../configuration/configuration-store.js';
import { configurationDigest } from '../configuration/launch-resolver.js';

export interface GitHubOperationReceipt {
  providerId?: string;
  url?: string;
  accepted: boolean;
}
export interface GitHubOperationRecord {
  podId: string;
  operationKey: string;
  requestDigest: string;
  state: 'ready' | 'sending' | 'succeeded' | 'failed' | 'uncertain';
  receipt: GitHubOperationReceipt | null;
  failureCode: string | null;
}
export function createGitHubOperationLedger(db: Database.Database) {
  function get(podId: string, key: string): GitHubOperationRecord | null {
    const row = db
      .prepare('SELECT * FROM retained_github_operations WHERE pod_id=? AND operation_key=?')
      .get(podId, key) as
      | {
          request_digest: string;
          state: GitHubOperationRecord['state'];
          receipt: string | null;
          failure_code: string | null;
        }
      | undefined;
    return row
      ? {
          podId,
          operationKey: key,
          requestDigest: row.request_digest,
          state: row.state,
          receipt: row.receipt ? (JSON.parse(row.receipt) as GitHubOperationReceipt) : null,
          failureCode: row.failure_code,
        }
      : null;
  }
  return {
    get,
    reserve(input: {
      podId: string;
      operationKey: string;
      operation: GitHubOperation;
      repositoryId: string;
      snapshotDigest: string;
      decision: GitHubPolicyDecision;
      parameters: unknown;
    }): GitHubOperationRecord {
      return db.transaction(() => {
        const { decision: _, ...request } = input;
        const requestDigest = configurationDigest(request);
        const existing = get(input.podId, input.operationKey);
        if (existing) {
          if (existing.requestDigest !== requestDigest)
            configurationError(
              'GitHub operation key was reused with different parameters',
              'GITHUB_OPERATION_CONFLICT',
              409,
            );
          return existing;
        }
        const now = new Date().toISOString();
        db.prepare(`INSERT INTO github_operations(pod_id,operation_key,request_digest,operation,repository_id,snapshot_digest,snapshot_rule_id,ceiling_rule_id,state,created_at,updated_at)
          VALUES(?,?,?,?,?,?,?,?,'ready',?,?)`).run(
          input.podId,
          input.operationKey,
          requestDigest,
          input.operation,
          input.repositoryId,
          input.snapshotDigest,
          input.decision.snapshotRuleId,
          input.decision.ceilingRuleId,
          now,
          now,
        );
        const created = get(input.podId, input.operationKey);
        if (!created)
          configurationError('GitHub operation reservation failed', 'GITHUB_LEDGER_ERROR', 500);
        return created;
      })();
    },
    /** Call only after rechecking current authorization, immediately before sending the mutation. */
    claim(podId: string, key: string, decision: GitHubPolicyDecision): boolean {
      return (
        db
          .prepare(`UPDATE github_operations SET state='sending',snapshot_rule_id=?,ceiling_rule_id=?,updated_at=?
        WHERE pod_id=? AND operation_key=? AND state='ready'`)
          .run(
            decision.snapshotRuleId,
            decision.ceilingRuleId,
            new Date().toISOString(),
            podId,
            key,
          ).changes === 1
      );
    },
    settle(
      podId: string,
      key: string,
      result:
        | { state: 'succeeded'; receipt: GitHubOperationReceipt }
        | { state: 'failed' | 'uncertain'; code: string },
    ): void {
      const changed = db
        .prepare(`UPDATE github_operations SET state=?,receipt=?,failure_code=?,updated_at=?
        WHERE pod_id=? AND operation_key=? AND state='sending'`)
        .run(
          result.state,
          result.state === 'succeeded' ? JSON.stringify(result.receipt) : null,
          result.state === 'succeeded' ? null : result.code,
          new Date().toISOString(),
          podId,
          key,
        ).changes;
      if (changed !== 1)
        configurationError(
          'GitHub operation cannot transition from its current state',
          'GITHUB_OPERATION_STATE_CONFLICT',
          409,
        );
    },
    /** Startup reconciliation does not retry writes whose response was lost. */
    recoverInterrupted(): number {
      return db
        .prepare(
          "UPDATE github_operations SET state='uncertain',failure_code='DAEMON_INTERRUPTED',updated_at=? WHERE state='sending'",
        )
        .run(new Date().toISOString()).changes;
    },
  };
}
