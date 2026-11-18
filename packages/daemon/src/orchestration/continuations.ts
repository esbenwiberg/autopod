import type { ManagedPodRequest } from '@autopod/shared';
import type Database from 'better-sqlite3';
import { canonical, digest } from '../managed/canonical.js';
import { validateManagedRequest } from '../managed/grants.js';
import type { ManagedPodService } from '../managed/managed-service.js';

/** Host-only reference to pinned source and trusted combined-check evidence. Not a wire API. */
export interface ContinuationCheckpoint {
  run: string;
  repository: string;
  predecessor: string;
  commit: string;
  tree: string;
  evidenceDigest: string;
  policyDigest: string;
}

/** Must resolve retained evidence and source from host custody, verify the complete binding
 * (including ancestry, policy and review), and return a managed service pinned to that source.
 * A controller-supplied receipt or location is never sufficient. No default permissive adapter. */
export type ResolveVerifiedExecutor = (
  checkpoint: Readonly<ContinuationCheckpoint>,
) => Promise<ManagedPodService>;
interface Intent {
  start_key: string;
  request_json: string;
  checkpoint_json: string;
  operation_digest: string;
  pod_id: string | null;
}
const commitId = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const hash = /^sha256:[0-9a-f]{64}$/;
// Dot is not a permitted installation character in the managed user authenticator.
const principal = (run: string) => `native.${run}`;

/** Internal acceptance/outbox. One run has one lifetime: cancellation is irreversible.
 * The request limit is the worker allowance after the host sets aside its final-check reserve. */
export class OrchestrationContinuations {
  constructor(
    private readonly db: Database.Database,
    private readonly resolve: ResolveVerifiedExecutor,
  ) {}

  open(
    run: string,
    repository: string,
    policyDigest: string,
    initialCommit: string,
    workerRequestLimit: number,
  ) {
    if (
      !/^[A-Za-z0-9_-]{1,64}$/.test(run) ||
      !repository ||
      !hash.test(policyDigest) ||
      !commitId.test(initialCommit) ||
      !Number.isSafeInteger(workerRequestLimit) ||
      workerRequestLimit < 1
    )
      throw new Error('invalid-run-envelope');
    this.db
      .prepare(
        'INSERT INTO orchestration_runs(id, repository, policy_digest, accepted_commit, worker_request_limit) VALUES (?,?,?,?,?)',
      )
      .run(run, repository, policyDigest, initialCommit, workerRequestLimit);
  }
  private prior(run: string, key: string) {
    return this.db
      .prepare('SELECT * FROM orchestration_continuations WHERE run_id=? AND start_key=?')
      .get(run, key) as Intent | undefined;
  }
  private async executor(cp: ContinuationCheckpoint) {
    const service = await this.resolve(Object.freeze({ ...cp }));
    if (service.db !== this.db) throw new Error('executor-outside-run-database');
    return service;
  }
  async acceptAndContinue(input: ContinuationCheckpoint, raw: ManagedPodRequest) {
    const cp = { ...input };
    const req = validateManagedRequest(raw);
    const repo = req.effectiveGrant.scope.repositories[0];
    const budget = req.effectiveGrant.budget;
    if (
      !commitId.test(cp.commit) ||
      !commitId.test(cp.tree) ||
      !commitId.test(cp.predecessor) ||
      cp.predecessor === cp.commit ||
      !hash.test(cp.evidenceDigest) ||
      !hash.test(cp.policyDigest) ||
      !['none', 'commit'].includes(req.outputs.source.mode) ||
      req.effectiveGrant.scope.allowedEffects.some(
        (effect) => effect === 'git.push.worker-branch' || effect.startsWith('pull-request.'),
      ) ||
      !repo ||
      req.effectiveGrant.scope.repositories.length !== 1 ||
      repo.enrollmentId !== cp.repository ||
      repo.baseRevision !== cp.commit ||
      !('maxProviderRequests' in budget)
    )
      throw new Error('invalid-continuation-binding');
    const operation = digest([cp, req.executionSpecDigest]);
    const replay = () => {
      const prior = this.prior(cp.run, req.startKey);
      if (prior && prior.operation_digest !== operation)
        throw new Error('continuation-key-conflict');
      return !!prior;
    };
    if (replay()) return;
    const service = await this.executor(cp);
    await service.preflight(req, principal(cp.run));
    this.db
      .transaction(() => {
        if (replay()) return;
        const result = this.db
          .prepare(
            `UPDATE orchestration_runs SET accepted_commit=?
             WHERE id=? AND repository=? AND policy_digest=? AND accepted_commit=? AND canceled=0
               AND worker_request_limit - COALESCE((SELECT sum(reserved_requests)
                    FROM orchestration_continuations WHERE run_id=?),0) >= ?`,
          )
          .run(
            cp.commit,
            cp.run,
            cp.repository,
            cp.policyDigest,
            cp.predecessor,
            cp.run,
            budget.maxProviderRequests,
          );
        if (!result.changes) throw new Error('continuation-not-admissible');
        this.db
          .prepare(
            `INSERT INTO orchestration_continuations(run_id,start_key,attempt_id,operation_digest,checkpoint_json,request_json,reserved_requests) VALUES(?,?,?,?,?,?,?)`,
          )
          .run(
            cp.run,
            req.startKey,
            req.dispatcherAttemptId,
            operation,
            canonical(cp),
            canonical(req),
            budget.maxProviderRequests,
          );
      })
      .immediate();
  }

  cancel(run: string) {
    this.db
      .transaction(() => {
        this.db.prepare('UPDATE orchestration_runs SET canceled=1 WHERE id=?').run(run);
        // Fence existing uncertain allocations, including one whose response was lost. The
        // managed watchdog owns stop/observed exit; never clear its reservation on stop request.
        this.db
          .prepare(
            'UPDATE managed_pods SET revoked=1,stop_requested=1 WHERE dispatcher_installation_id=? AND observed_exit=0',
          )
          .run(principal(run));
      })
      .immediate();
  }

  /** One pass, on startup or after admission. A blocked intent must not starve other runs. */
  async recover() {
    const pending = this.db
      .prepare(
        `SELECT c.* FROM orchestration_continuations c JOIN orchestration_runs r ON r.id=c.run_id WHERE r.canceled=0 AND c.pod_id IS NULL ORDER BY c.rowid`,
      )
      .all() as (Intent & { run_id: string })[];
    const blocked: { run: string; key: string; stage: 'binding' | 'source' | 'launch' }[] = [];
    for (const intent of pending) {
      let stage: 'binding' | 'source' | 'launch' = 'binding';
      try {
        const cp = JSON.parse(intent.checkpoint_json) as ContinuationCheckpoint;
        const req = validateManagedRequest(JSON.parse(intent.request_json));
        if (
          cp.run !== intent.run_id ||
          req.startKey !== intent.start_key ||
          digest([cp, req.executionSpecDigest]) !== intent.operation_digest
        )
          throw new Error('continuation-ledger-mismatch');
        stage = 'source';
        const s = await this.executor(cp);
        stage = 'launch';
        const installation = principal(cp.run);
        const assertActive = () => {
          if (
            !this.db
              .prepare('SELECT 1 FROM orchestration_runs WHERE id=? AND canceled=0')
              .get(cp.run)
          )
            throw new Error('run-canceled');
        };
        assertActive();
        const row = s.lookup(installation, req.startKey);
        if (row && row.execution_spec_digest !== req.executionSpecDigest)
          throw new Error('managed-start-conflict');
        // Inspecting a previously allocated/terminal attempt never starts another worker.
        const pod =
          row && (row.observed_exit || (row.runtime_ref && row.state !== 'queued'))
            ? row.pod_id
            : (await s.start(installation, req, undefined, assertActive)).podId;
        this.db
          .prepare(
            'UPDATE orchestration_continuations SET pod_id=? WHERE run_id=? AND start_key=? AND pod_id IS NULL',
          )
          .run(pod, cp.run, req.startKey);
      } catch {
        blocked.push({ run: intent.run_id, key: intent.start_key, stage });
      }
    }
    return { blocked };
  }
}
