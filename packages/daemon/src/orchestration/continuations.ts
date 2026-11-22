import type { ManagedPodRequest } from '@autopod/shared';
import type Database from 'better-sqlite3';
import { canonical, digest } from '../managed/canonical.js';
import { validateManagedRequest } from '../managed/grants.js';
import { signalLocalRun } from '../managed/local-run-signals.js';
import type { ManagedPodService } from '../managed/managed-service.js';
import { tryRecoveryClaim } from './local-recovery-claim.js';
import { RunWaves } from './run-waves.js';

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
export type WithVerifiedExecutor = <T>(
  checkpoint: Readonly<ContinuationCheckpoint>,
  use: (service: ManagedPodService) => Promise<T>,
) => Promise<T>;
type Kind = 'advance' | 'spawn';
// Preserve the digest of existing advance intents across the upgrade.
const operationDigest = (kind: Kind, cp: ContinuationCheckpoint, spec: string) =>
  digest(kind === 'spawn' ? ['spawn', cp, spec] : [cp, spec]);
interface Intent {
  operation_kind: Kind;
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

function boundRequest(cp: ContinuationCheckpoint, raw: ManagedPodRequest) {
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
  return { req, budget };
}

/** Internal acceptance/outbox. One run has one lifetime: cancellation is irreversible.
 * The request limit is the worker allowance after the host sets aside its final-check reserve. */
export class OrchestrationContinuations {
  readonly waves: RunWaves;
  constructor(
    private readonly db: Database.Database,
    private readonly resolve: WithVerifiedExecutor,
  ) {
    this.waves = new RunWaves(db);
  }

  open(
    run: string,
    repository: string,
    policyDigest: string,
    initialCommit: string,
    workerRequestLimit: number,
    maxActive = 1,
  ) {
    if (
      !/^[A-Za-z0-9_-]{1,64}$/.test(run) ||
      !repository ||
      !hash.test(policyDigest) ||
      !commitId.test(initialCommit) ||
      !Number.isSafeInteger(workerRequestLimit) ||
      workerRequestLimit < 1 ||
      !Number.isSafeInteger(maxActive) ||
      maxActive < 1
    )
      throw new Error('invalid-run-envelope');
    this.db
      .prepare(
        'INSERT INTO orchestration_runs(id, repository, policy_digest, accepted_commit, worker_request_limit,max_active) VALUES (?,?,?,?,?,?)',
      )
      .run(run, repository, policyDigest, initialCommit, workerRequestLimit, maxActive);
  }
  private prior(run: string, key: string) {
    return this.db
      .prepare('SELECT * FROM orchestration_continuations WHERE run_id=? AND start_key=?')
      .get(run, key) as Intent | undefined;
  }
  private withExecutor<T>(
    cp: ContinuationCheckpoint,
    use: (service: ManagedPodService) => Promise<T>,
  ) {
    return this.resolve(Object.freeze({ ...cp }), async (service) => {
      if (service.db !== this.db) throw new Error('executor-outside-run-database');
      return use(service);
    });
  }
  /** Establish a verified starting point and recipe catalog WITHOUT launching a placeholder
   * child. The first model turn uses a real wait and the same journal/budget as later turns. */
  async kickoff(
    input: ContinuationCheckpoint,
    recipes: Readonly<Record<string, ManagedPodRequest>>,
    parentProposal?: true,
  ) {
    const cp = { ...input };
    const entries = Object.entries(recipes);
    if (
      !entries.length ||
      entries.length > 16 ||
      entries.some(([alias]) => !/^[a-z][a-z0-9_-]{0,63}$/.test(alias))
    )
      throw new Error('invalid-kickoff-recipes');
    const catalog = Object.fromEntries(
      entries.map(([key, raw]) => [key, boundRequest(cp, raw).req]),
    );
    const seed = digest([cp, catalog]);
    const replay = () => {
      const prior = this.db
        .prepare('SELECT seed_digest FROM orchestration_kickoffs WHERE run_id=?')
        .pluck()
        .get(cp.run);
      if (prior !== undefined && prior !== seed) throw new Error('kickoff-conflict');
      return prior !== undefined;
    };
    if (replay()) return;
    await this.withExecutor(cp, async (service) => {
      for (const req of Object.values(catalog))
        await service.preflight(req, principal(cp.run), parentProposal);
    });
    this.db
      .transaction(() => {
        if (replay()) return;
        const result = this.db
          .prepare(
            'UPDATE orchestration_runs SET accepted_commit=?,accepted_evidence=? WHERE id=? AND repository=? AND policy_digest=? AND accepted_commit=? AND accepted_evidence IS NULL AND canceled=0',
          )
          .run(
            cp.commit,
            cp.evidenceDigest,
            cp.run,
            cp.repository,
            cp.policyDigest,
            cp.predecessor,
          );
        if (!result.changes) throw new Error('kickoff-not-admissible');
        this.db
          .prepare(
            'INSERT INTO orchestration_kickoffs(run_id,seed_digest,checkpoint_json,recipes_json) VALUES(?,?,?,?)',
          )
          .run(cp.run, seed, canonical(cp), canonical(catalog));
        this.db
          .prepare(
            "INSERT INTO orchestration_result_waits(run_id,wait_key,after_cursor,minimum) VALUES(?,'@kickoff',0,1)",
          )
          .run(cp.run);
        signalLocalRun(this.db, principal(cp.run));
      })
      .immediate();
  }
  acceptAndContinue(input: ContinuationCheckpoint, raw: ManagedPodRequest) {
    return this.admit('advance', input, raw);
  }
  spawnFromAccepted(input: ContinuationCheckpoint, raw: ManagedPodRequest) {
    return this.admit('spawn', input, raw);
  }
  /** Preflight outside SQLite, then reserve the whole controller proposal or none of it. */
  async spawnWave(
    input: ContinuationCheckpoint,
    requests: ManagedPodRequest[],
    assertOwnerActive?: () => void,
    parentProposal?: true,
  ) {
    if (requests.length > 8) throw new Error('controller-wave-too-large');
    await this.admitBatch('spawn', input, requests, assertOwnerActive, parentProposal);
  }
  private async admitBatch(
    kind: Kind,
    input: ContinuationCheckpoint,
    requests: ManagedPodRequest[],
    assertOwnerActive?: () => void,
    parentProposal?: true,
  ) {
    const cp = { ...input };
    const pending: ManagedPodRequest[] = [];
    const inserts = requests.map((request) => this.prepare(kind, cp, request, pending));
    // Same pinned source for the whole proposal: restore/verify custody once, but
    // independently preflight every fresh spec. Replayed intents need no new preflight.
    if (pending.length)
      await this.withExecutor(cp, async (service) => {
        for (const req of pending) await service.preflight(req, principal(cp.run), parentProposal);
      });
    const changed = this.db
      .transaction(() => {
        assertOwnerActive?.();
        let changed = false;
        for (const insert of inserts) if (insert()) changed = true;
        return changed;
      })
      .immediate();
    if (changed) signalLocalRun(this.db, principal(cp.run));
  }
  private async admit(kind: Kind, input: ContinuationCheckpoint, raw: ManagedPodRequest) {
    await this.admitBatch(kind, input, [raw]);
    return raw.startKey;
  }
  private prepare(
    kind: Kind,
    input: ContinuationCheckpoint,
    raw: ManagedPodRequest,
    pending: ManagedPodRequest[],
  ) {
    const cp = { ...input };
    const { req, budget } = boundRequest(cp, raw);
    const operation = operationDigest(kind, cp, req.executionSpecDigest);
    const replay = () => {
      const prior = this.prior(cp.run, req.startKey);
      if (prior && prior.operation_digest !== operation)
        throw new Error('continuation-key-conflict');
      return !!prior;
    };
    if (!replay()) pending.push(req);
    return () => {
      if (replay()) return false;
      const run = this.db
        .prepare(
          'SELECT remaining,accepted_evidence FROM orchestration_runs JOIN orchestration_request_balances USING(id) WHERE id=?',
        )
        .get(cp.run) as { remaining: number; accepted_evidence: string | null } | undefined;
      if (!run || (kind === 'spawn' && run.accepted_evidence !== cp.evidenceDigest))
        throw new Error('continuation-not-admissible');
      if (run.remaining < budget.maxProviderRequests)
        throw new Error('continuation-budget-exhausted');
      const result = this.db
        .prepare(
          `UPDATE orchestration_runs SET accepted_commit=?, accepted_evidence=?
             WHERE id=? AND repository=? AND policy_digest=? AND accepted_commit=? AND canceled=0`,
        )
        .run(
          cp.commit,
          cp.evidenceDigest,
          cp.run,
          cp.repository,
          cp.policyDigest,
          kind === 'advance' ? cp.predecessor : cp.commit,
        );
      if (!result.changes) throw new Error('continuation-not-admissible');
      this.db
        .prepare(
          `INSERT INTO orchestration_continuations(run_id,start_key,attempt_id,operation_digest,checkpoint_json,request_json,reserved_requests,operation_kind) VALUES(?,?,?,?,?,?,?,?)`,
        )
        .run(
          cp.run,
          req.startKey,
          req.dispatcherAttemptId,
          operation,
          canonical(cp),
          canonical(req),
          budget.maxProviderRequests,
          kind,
        );
      return true;
    };
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
  async recover(run?: string) {
    const pending = this.db
      .prepare(
        `SELECT c.* FROM orchestration_continuations c JOIN orchestration_runs r ON r.id=c.run_id WHERE r.canceled=0 AND c.pod_id IS NULL AND (? IS NULL OR r.id=?) ORDER BY c.rowid`,
      )
      .all(run ?? null, run ?? null) as (Intent & { run_id: string })[];
    type Stage = 'claim' | 'binding' | 'source' | 'launch' | 'capacity' | 'allocation-unknown';
    const blocked: { run: string; key: string; stage: Stage }[] = [];
    for (const intent of pending) {
      let stage: Stage = 'claim';
      let release: (() => void) | null = null;
      try {
        release = tryRecoveryClaim(this.db, intent.run_id, intent.start_key);
        if (!release) {
          blocked.push({ run: intent.run_id, key: intent.start_key, stage });
          continue;
        }
        if (this.prior(intent.run_id, intent.start_key)?.pod_id) continue;
        stage = 'binding';
        const cp = JSON.parse(intent.checkpoint_json) as ContinuationCheckpoint;
        const req = validateManagedRequest(JSON.parse(intent.request_json));
        if (
          cp.run !== intent.run_id ||
          req.startKey !== intent.start_key ||
          operationDigest(intent.operation_kind, cp, req.executionSpecDigest) !==
            intent.operation_digest
        )
          throw new Error('continuation-ledger-mismatch');
        stage = 'source';
        await this.withExecutor(cp, async (s) => {
          stage = 'launch';
          const installation = principal(cp.run);
          const assertActive = () => {
            if (
              !this.db
                .prepare('SELECT 1 FROM orchestration_runs WHERE id=? AND canceled=0')
                .get(cp.run)
            )
              throw new Error('run-canceled');
            // Also called inside managed start's SQLite reservation transaction:
            // concurrent hosts cannot spend the same free slot. Replays own their slot.
            if (!s.lookup(installation, req.startKey) && !this.waves.available(cp.run)) {
              stage = 'capacity';
              throw new Error('run-at-capacity');
            }
          };
          assertActive();
          const row = s.lookup(installation, req.startKey);
          if (row && row.execution_spec_digest !== req.executionSpecDigest)
            throw new Error('managed-start-conflict');
          if (row?.allocation_attempted && !row.runtime_ref && !row.observed_exit) {
            stage = 'allocation-unknown';
            throw new Error('continuation-allocation-unknown');
          }
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
          signalLocalRun(this.db, principal(cp.run));
        });
      } catch {
        blocked.push({ run: intent.run_id, key: intent.start_key, stage });
      } finally {
        release?.();
      }
    }
    return { blocked };
  }
}
