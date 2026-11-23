import type Database from 'better-sqlite3';
import { canonical } from '../managed/canonical.js';
import type { LocalCheckpointHost } from './local-checkpoints.js';
import type { ParentIntegrationInput } from './parent-candidate-integration.js';
import { ParentEvaluatorVeto } from './parent-exact-tree-evaluator.js';
import {
  type ParentIntegrationGates,
  parentIntegrationGateDigest,
  qualifyParentIntegration,
} from './parent-integration-qualified.js';

export function parentQualificationJob(
  db: Database.Database,
  host: LocalCheckpointHost,
  scratch: string,
  run: string,
  paths: readonly string[],
  gates: ParentIntegrationGates,
  secondPaths?: readonly string[],
) {
  const scopes = [paths, secondPaths ?? paths].map((names) =>
    names.map((path) => ({ kind: 'file' as const, path })),
  );
  const select = db.prepare(`
    SELECT q.request_key AS requestKey,
      json_extract(p.candidate_json,'$.candidateDigest') AS candidateDigest, p.tree AS expectedTree,
      q.private_scope_json AS scope
    FROM parent_managed_requests q
    JOIN orchestration_runs r ON r.id=q.run_id AND r.canceled=0
    JOIN orchestration_continuations c ON c.run_id=q.run_id AND c.start_key=q.start_key
    JOIN managed_pods m ON m.pod_id=c.pod_id AND m.dispatcher_installation_id=('native.'||q.run_id)
      AND m.managed_start_key=q.start_key AND m.dispatcher_attempt_id=c.attempt_id
      AND m.state='complete' AND m.observed_exit=1 AND m.exit_code=0 AND m.revoked=0 AND m.stop_requested=0
    JOIN parent_private_candidates p ON p.pod_id=m.pod_id
    WHERE q.run_id=? AND q.private_scope_json IS NOT NULL
    ORDER BY q.rowid LIMIT 3`);
  const reserve = db.transaction(() => {
    if (db.prepare('SELECT 1 FROM parent_qualification_jobs WHERE run_id=?').get(run)) return;
    const rows = select.all(run) as (Omit<ParentIntegrationInput, 'allowlist'> & {
      scope: string;
    })[];
    if (rows.length !== 2 || rows.some((row, index) => row.scope !== canonical(scopes[index])))
      return;
    const inputs = rows.map(({ scope: _, ...row }, index) => ({
      ...row,
      allowlist: scopes[index]!,
    }));
    db.prepare(
      "INSERT INTO parent_qualification_jobs (run_id,selection_json,status) VALUES (?,?,'reserved')",
    ).run(run, canonical(inputs));
  }).immediate;
  const reserved = db
    .prepare(
      "SELECT selection_json FROM parent_qualification_jobs WHERE run_id=? AND status='reserved'",
    )
    .pluck();
  const update = db.prepare(
    'UPDATE parent_qualification_jobs SET status=?, evidence_digest=? WHERE run_id=? AND status=?',
  );
  // The selection remains immutable. Pin the integration digest in the first
  // send transition and require the same digest before the second send.
  const claimCheck = db.prepare(`UPDATE parent_qualification_jobs
    SET status='checks', input_digest=?
    WHERE run_id=? AND status='reserved' AND selection_json=? AND input_digest IS NULL`);
  const claimReview = db.prepare(`UPDATE parent_qualification_jobs SET status='independentReview'
    WHERE run_id=? AND status='checks' AND input_digest=?`);
  function transition(from: string, to: string, evidence: string | null = null) {
    if (update.run(to, evidence, run, from).changes !== 1)
      throw new Error('parent-qualification-job-stale');
  }
  let pending: Promise<void> | undefined;
  return {
    // Called by private completion in the transaction marking the second child complete.
    reserve,
    /** Called once under exclusive daemon ownership. Never sends or reconstructs a request. */
    recover() {
      // Startup must not initiate evaluation. Distinguish a proven unsent job
      // from a lost send so operators never treat either as qualified.
      db.prepare(`UPDATE parent_qualification_jobs
        SET status=CASE status WHEN 'reserved' THEN 'not-sent' ELSE 'unknown' END
        WHERE run_id=? AND status IN ('reserved','checks','independentReview')`).run(run);
    },
    tick() {
      if (pending) return pending;
      const selection = reserved.get(run);
      if (typeof selection !== 'string') return Promise.resolve();
      const inputs = JSON.parse(selection) as [ParentIntegrationInput, ParentIntegrationInput];
      let stage = 'reserved';
      const send =
        (role: 'checks' | 'independentReview'): ParentIntegrationGates[typeof role] =>
        async (request, bundle) => {
          const inputDigest = parentIntegrationGateDigest(request);
          const updated =
            role === 'checks'
              ? claimCheck.run(inputDigest, run, selection)
              : claimReview.run(run, inputDigest);
          if (updated.changes !== 1) throw new Error('parent-qualification-job-stale');
          stage = role;
          return gates[role](request, bundle);
        };
      pending = qualifyParentIntegration(
        db,
        host,
        scratch,
        run,
        inputs,
        {
          policy: gates.policy,
          checks: send('checks'),
          independentReview: send('independentReview'),
        },
        (evidence) => transition('independentReview', 'ready', evidence),
      )
        .then(
          () => {},
          (error: unknown) => {
            // A trusted, explicit rejection is settled. An arbitrary error or a
            // lost reply after dispatch still leaves the outcome unknown.
            const rejected = error instanceof ParentEvaluatorVeto && error.role === stage;
            transition(stage, stage === 'reserved' || rejected ? 'failed' : 'unknown');
          },
        )
        .finally(() => {
          pending = undefined;
        });
      return pending;
    },
  };
}
export type ParentQualificationJob = ReturnType<typeof parentQualificationJob>;
