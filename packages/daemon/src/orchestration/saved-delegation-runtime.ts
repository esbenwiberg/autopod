import { randomUUID } from 'node:crypto';
import type { ManagedPodRequest } from '@autopod/shared';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import type { PodTokenIssuer } from '../crypto/pod-tokens.js';
import { canonical, digest } from '../managed/canonical.js';
import type { ManagedContainerRuntime } from '../managed/container-runtime.js';
import { validateManagedRequest } from '../managed/grants.js';
import type { ManagedPodService } from '../managed/managed-service.js';
import {
  assertPrivateParentCommit,
  isPrivateSubmission,
} from '../managed/private-commit-policy.js';
import type { ParentDeltaSource } from './anchored-delegation-source.js';
import { OrchestrationContinuations } from './continuations.js';
import { projectManagedRecipe } from './controller-turns.js';
import { LocalCheckpointHost, withVerifiedCheckpointMirror } from './local-checkpoints.js';
import { tryControllerOwner } from './local-recovery-claim.js';
import type { ParentIntegrationGates } from './parent-integration-qualified.js';
import { parentPrivateCompletion } from './parent-private-completion.js';
import { parentQualificationJob } from './parent-qualification-job.js';
import { ParentReportResults } from './parent-report-results.js';
import {
  readSavedDelegationAdmission,
  savedDelegationAttemptRun,
  savedDelegationGatePolicy,
} from './saved-delegation-admission.js';
import type { DelegationPrincipal } from './saved-delegation-policy.js';

const proposal = z
  .object({
    requestKey: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
    recipe: z.string().min(1).max(64),
    brief: z.string().trim().min(1).max(2048),
  })
  .strict();

/** Trusted, one-run composition. Normal daemon launch isn't connected to these
 * ports yet. A worker cannot supply a recipe, checkout adapter or gate policy. */
export function attachSavedDelegationRuntime(input: {
  db: Database.Database;
  podId: string;
  principal: DelegationPrincipal;
  scratch: string;
  issuer: PodTokenIssuer;
  runtimeDigest: string;
  recipes: Readonly<Record<string, ManagedPodRequest>>;
  gates: ParentIntegrationGates;
  service: ManagedPodService;
  collector: Pick<ManagedContainerRuntime, 'exportPrivateHead' | 'readPrivateSubmission'>;
  /** Bind the exact mirror to the worker service for this operation; never fall back to a branch. */
  withWorkerSource<T>(mirror: string, run: string, use: () => Promise<T>): Promise<T>;
  /** Observe the checkout that the parent will actually run against. */
  observeParentSource(podId: string): Promise<{ commit: string; tree: string; clean: boolean }>;
}) {
  const { db, podId, issuer, service, scratch } = input;
  const principal = { ...input.principal };
  const currentSeed = () => readSavedDelegationAdmission(db, podId, principal);
  const { plan, checkpoint } = currentSeed();
  const { run, commit, tree, repository } = checkpoint;
  const installation = 'native.' + run;
  const artifactPipeline = service.artifactPipeline;
  if (
    !issuer.generateAttempt ||
    !issuer.verifyAttempt ||
    service.db !== db ||
    !artifactPipeline ||
    service.privateCommit ||
    !service.ownsInstallation(installation) ||
    input.runtimeDigest !== plan.pins.runtimeDigest ||
    canonical(input.gates.policy) !== canonical(savedDelegationGatePolicy(plan))
  )
    throw new Error('saved-delegation-runtime-binding');
  const [left, right] = plan.policy.workers;
  const byRole = new Map<string, { template: ManagedPodRequest; files: readonly string[] }>();
  for (const [index, worker] of plan.policy.workers.entries()) {
    const raw = Object.hasOwn(input.recipes, worker.role) ? input.recipes[worker.role] : undefined;
    if (!raw) throw new Error('saved-delegation-recipe-binding');
    const template = validateManagedRequest(structuredClone(raw));
    const budget = template.effectiveGrant.budget;
    assertPrivateParentCommit(template, repository, commit, 'sandbox');
    if (
      template.executionSpecDigest !== plan.pins.workers[index]?.executionSpecDigest ||
      !isPrivateSubmission(template) ||
      template.route.providerAccountId !== worker.accountId ||
      !('maxProviderRequests' in budget) ||
      budget.maxProviderRequests !== worker.modelRequests ||
      budget.maxObservedTokens !== worker.observedTokenStop ||
      budget.maxDurationSeconds !== worker.wallSeconds
    )
      throw new Error('saved-delegation-recipe-binding');
    byRole.set(worker.role, { template, files: worker.files });
  }
  const catalog = Object.fromEntries([...byRole].map(([role, value]) => [role, value.template]));
  let closed = false;
  const pending = new Set<Promise<unknown>>();
  function open() {
    if (closed) throw new Error('saved-delegation-runtime-closed');
  }
  function track<T>(operation: () => Promise<T>) {
    open();
    const task = operation();
    pending.add(task);
    task.then(
      () => pending.delete(task),
      () => pending.delete(task),
    );
    return task;
  }
  const withParentSeed = <T>(use: (mirror: string) => Promise<T>) => {
    open();
    const seed = currentSeed();
    if (seed.checkpoint.evidenceDigest !== checkpoint.evidenceDigest)
      throw new Error('saved-delegation-seed-changed');
    return withVerifiedCheckpointMirror(scratch, checkpoint, seed.bundle, use);
  };
  const delta: ParentDeltaSource | undefined =
    plan.pins.source.resultTransport === 'anchored/v1'
      ? { base: commit, tree, withBase: withParentSeed }
      : undefined;
  const ledger = new OrchestrationContinuations(db, async (cp, use) => {
    if (canonical(cp) !== canonical(checkpoint)) throw new Error('saved-delegation-seed-mismatch');
    return withParentSeed((mirror) => input.withWorkerSource(mirror, run, () => use(service)));
  });
  // Qualification only retains evaluated bytes. Its checkpoint host cannot be used as a worker executor.
  const qualificationHost = new LocalCheckpointHost(db, scratch, () => {
    throw new Error('saved-delegation-qualification-only');
  });
  const job = parentQualificationJob(
    db,
    qualificationHost,
    scratch,
    run,
    left.files,
    input.gates,
    right.files,
    true,
    delta,
  );
  const completion = parentPrivateCompletion(
    service,
    input.collector,
    scratch,
    checkpoint,
    left.files,
    job.reserve,
    right.files,
    delta,
  );
  const release = tryControllerOwner(db, run);
  if (!release) throw new Error('saved-delegation-runtime-already-attached');
  try {
    job.recover();
    service.privateCommit = completion;
  } catch (error) {
    release();
    throw error;
  }
  const reports = new ParentReportResults(db);
  const active = (token: string) => {
    open();
    if (savedDelegationAttemptRun(db, issuer, podId, token) !== run)
      throw new Error('saved-delegation-session-mismatch');
    return run;
  };
  let ticking: Promise<void> | undefined;
  let closing: Promise<void> | undefined;
  function identity() {
    const row = db
      .prepare(`SELECT p.lifecycle_generation AS generation,p.container_id AS container
      FROM pods p JOIN orchestration_runs r ON r.id=? AND r.canceled=0
      WHERE p.id=? AND p.launch_config_digest=? AND p.user_id=? AND p.status='running' AND p.container_id IS NOT NULL`)
      .get(run, podId, plan.launchDigest, principal.oid) as
      | { generation: number; container: string }
      | undefined;
    open();
    if (!row) throw new Error('saved-delegation-parent-not-running');
    return row;
  }
  return {
    withPinnedParentSource: <T>(use: (mirror: string) => Promise<T>) =>
      track(() => withParentSeed(use)),
    provision: () =>
      track(async () => {
        const expected = canonical(identity());
        const observed = await input.observeParentSource(podId);
        if (
          observed.commit !== commit ||
          observed.tree !== tree ||
          observed.clean !== true ||
          canonical(identity()) !== expected
        )
          throw new Error('saved-delegation-parent-checkout-mismatch');
        await ledger.kickoff(checkpoint, catalog, true);
        return db
          .transaction(() => {
            const now = identity();
            if (canonical(now) !== expected) throw new Error('saved-delegation-parent-changed');
            const attempt = randomUUID();
            db.prepare(
              'INSERT INTO parent_managed_sessions(attempt,run_id,generation,container_id) VALUES(?,?,?,?)',
            ).run(attempt, run, now.generation, now.container);
            db.prepare('UPDATE parent_managed_runs SET current_attempt=? WHERE run_id=?').run(
              attempt,
              run,
            );
            return issuer.generateAttempt!(podId, attempt);
          })
          .immediate();
      }),
    commission: (token: string, raw: unknown) =>
      track(async () => {
        active(token);
        const request = proposal.parse(raw);
        const selected = byRole.get(request.recipe);
        if (!selected) throw new Error('saved-delegation-role-refused');
        const key = 'parent-' + digest([run, request.requestKey]).slice(7);
        const inputDigest = digest(request);
        const prior = () =>
          db
            .prepare(
              'SELECT input_digest FROM parent_managed_requests WHERE run_id=? AND start_key=?',
            )
            .pluck()
            .get(run, key);
        const replay = () => {
          const old = prior();
          if (old !== undefined && old !== inputDigest) throw new Error('parent-request-conflict');
          return old !== undefined;
        };
        if (!replay()) {
          const scope = canonical(selected.files.map((path) => ({ kind: 'file', path })));
          const spec = projectManagedRecipe(
            selected.template,
            request.brief +
              '\n\nSubmit changes only to these assigned paths: ' +
              canonical(selected.files),
            key,
          );
          await ledger.spawnWave(
            checkpoint,
            [spec],
            () => {
              active(token);
              if (replay()) return;
              if (
                db
                  .prepare(
                    'SELECT 1 FROM parent_managed_requests WHERE run_id=? AND private_scope_json=?',
                  )
                  .get(run, scope)
              )
                throw new Error('saved-delegation-role-already-reserved');
              const attempt = issuer.verifyAttempt!(token)!.attempt;
              db.prepare(`INSERT INTO parent_managed_requests(run_id,start_key,request_key,parent_attempt,input_digest,private_scope_json)
            VALUES(?,?,?,?,?,?)`).run(run, key, request.requestKey, attempt, inputDigest, scope);
            },
            true,
          );
        }
        active(token);
        return { requestKey: request.requestKey, reserved: true as const };
      }),
    authorizeAttempt: active,
    results: (token: string, raw: unknown) =>
      track(() => reports.results(raw, () => active(token))),
    wait: (token: string, raw: unknown) => track(() => reports.wait(raw, () => active(token))),
    tick() {
      ticking ??= track(async () => {
        await ledger.recover(run);
        if (closed) return;
        await service.enforceExpiry(installation);
        await artifactPipeline.tick(installation);
        if (!closed) await job.tick();
      }).finally(() => {
        ticking = undefined;
      });
      return ticking;
    },
    close() {
      closed = true;
      closing ??= Promise.allSettled(pending).then(() => {
        if (service.privateCommit === completion) service.privateCommit = undefined;
        release();
      });
      return closing;
    },
  };
}
