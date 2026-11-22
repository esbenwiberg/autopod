import { type EffectiveLaunchConfig, launchRequestSchema } from '@autopod/shared';
import type Database from 'better-sqlite3';
import { configurationError } from '../configuration/configuration-store.js';
import { configurationDigest } from '../configuration/launch-resolver.js';
import { createLaunchSnapshotRepository } from '../configuration/launch-snapshot.js';
import type { PodTokenIssuer } from '../crypto/pod-tokens.js';
import { canonical, digest, sha256 } from '../managed/canonical.js';
import { MAX_CANDIDATE_BYTES } from '../managed/source-git.js';
import { withVerifiedCheckpointMirror } from './local-checkpoints.js';
import { prepareSavedDelegationLaunch, savedDelegationRunId } from './saved-delegation-launch.js';
import { type DelegationPrincipal, delegationOwnerDigest } from './saved-delegation-policy.js';

type Planning = Parameters<typeof prepareSavedDelegationLaunch>[0];
type Plan = Awaited<ReturnType<typeof prepareSavedDelegationLaunch>>['plan'];

function describeSeed(plan: Plan) {
  const { predecessor, commit, tree, bundleDigest } = plan.pins.source;
  const subject = {
    run: plan.runId,
    repository: plan.policy.repositoryId,
    predecessor,
    commit,
    tree,
    policyDigest: digest(['saved-delegation-authority/v1', plan.digest]),
  };
  // Verifies origin and exact Git bytes, not checks/review of a combined result.
  const manifest = canonical({
    version: 1,
    origin: 'saved-delegation-seed/v1',
    subject,
    bundleDigest,
  });
  return { manifest, checkpoint: { ...subject, evidenceDigest: sha256(manifest) } };
}

/** Host-only retained read. Do not expose the bundle or this function as a wire API. */
export function readSavedDelegationAdmission(
  db: Database.Database,
  podId: string,
  principal: DelegationPrincipal,
) {
  const owner = delegationOwnerDigest(principal);
  const row = db
    .prepare(`SELECT a.request_id, a.plan_digest, a.run_id,
    b.launch_digest, b.policy_digest, b.policy_json,
    r.repository, r.worker_request_limit, r.max_active, r.operator_owned,
    s.manifest, s.bundle, a.seed_evidence_digest
    FROM saved_delegation_admissions a
    JOIN parent_managed_runs b ON b.run_id=a.run_id
    JOIN orchestration_runs r ON r.id=a.run_id AND r.policy_digest=b.policy_digest
    JOIN orchestration_checkpoint_custody s ON s.run_id=a.run_id AND s.evidence_digest=a.seed_evidence_digest
    WHERE b.pod_id=? AND a.owner_digest=?`)
    .get(podId, owner) as
    | {
        request_id: string;
        plan_digest: string;
        run_id: string;
        launch_digest: string;
        policy_digest: string;
        policy_json: string;
        repository: string;
        worker_request_limit: number;
        max_active: number;
        operator_owned: number;
        manifest: string;
        bundle: Buffer;
        seed_evidence_digest: string;
      }
    | undefined;
  if (!row)
    configurationError(
      'Saved delegation admission not found',
      'DELEGATION_ADMISSION_NOT_FOUND',
      404,
    );
  const corrupt = () =>
    configurationError(
      'Saved delegation admission failed integrity check',
      'DELEGATION_ADMISSION_CORRUPT',
      500,
    );
  const plan = JSON.parse(row.policy_json) as Plan;
  const { digest: planDigest, ...body } = plan;
  if (
    planDigest !== row.plan_digest ||
    configurationDigest(body) !== planDigest ||
    row.run_id !== plan.runId ||
    row.request_id !== plan.requestId ||
    plan.runId !== savedDelegationRunId(owner, row.request_id) ||
    row.launch_digest !== plan.launchDigest
  )
    corrupt();
  const { checkpoint, manifest } = describeSeed(plan);
  if (
    row.policy_digest !== checkpoint.policyDigest ||
    row.repository !== checkpoint.repository ||
    row.worker_request_limit !== plan.workerModelRequests ||
    row.max_active !== plan.policy.maxConcurrentWorkers ||
    row.operator_owned !== 1 ||
    row.seed_evidence_digest !== checkpoint.evidenceDigest ||
    row.manifest !== manifest ||
    sha256(row.bundle) !== plan.pins.source.bundleDigest
  )
    corrupt();
  return { plan, checkpoint, bundle: row.bundle };
}

/** Resolve a parent credential to its one live, durable session. Recheck at a
 * result read and again inside a reservation; a request never supplies a run ID. */
export function savedDelegationAttemptRun(
  db: Database.Database,
  issuer: PodTokenIssuer,
  podId: string,
  token: string,
): string {
  const attempt = issuer.verifyAttempt?.(token);
  if (!attempt || attempt.podId !== podId) throw new Error('parent-session-required');
  const run = db
    .prepare(`SELECT b.run_id FROM parent_managed_runs b
    JOIN saved_delegation_admissions a ON a.run_id=b.run_id
    JOIN pods p ON p.id=b.pod_id AND p.launch_config_digest=b.launch_digest
    JOIN orchestration_runs r ON r.id=b.run_id AND r.canceled=0 AND r.policy_digest=b.policy_digest
    JOIN parent_managed_sessions s ON s.run_id=b.run_id AND s.attempt=b.current_attempt
      AND s.generation=p.lifecycle_generation AND s.container_id=p.container_id
    WHERE b.pod_id=? AND s.attempt=? AND p.status='running'`)
    .pluck()
    .get(podId, attempt.attempt);
  if (typeof run !== 'string') throw new Error('parent-session-stale');
  return run;
}

/**
 * Trusted host entrypoint only. No external writes in preparation, synchronous DB
 * operations in admission. Callers must not dispatch or mount a workspace here.
 * The live ordinary launch route deliberately does not call this entrypoint.
 */
export async function admitSavedDelegationLaunch(
  input: Planning & {
    db: Database.Database;
    scratch: string;
    readSeedBundle(plan: Readonly<Plan>): Promise<Buffer>;
    insertPod(config: EffectiveLaunchConfig): string;
  },
) {
  if (!input.policies.usesDatabase(input.db)) throw new Error('saved-delegation-database-mismatch');
  const request = launchRequestSchema.parse(input.request);
  if (!request.delegation || !request.requestId || !request.expectedDigest)
    configurationError(
      'A reviewed saved delegation plan is required',
      'DELEGATION_PREVIEW_REQUIRED',
      409,
    );
  const principal = { ...input.principal };
  const owner = delegationOwnerDigest(principal);
  const requestDigest = configurationDigest(['saved-delegation-admission/v1', owner, request]);
  const snapshots = createLaunchSnapshotRepository(input.db, input.launch.store);
  const receipt = (podId: string, created: boolean) => {
    const config = snapshots.getOriginal(podId);
    const { plan, checkpoint } = readSavedDelegationAdmission(input.db, podId, principal);
    if (!config || config.digest !== plan.launchDigest || plan.digest !== request.expectedDigest)
      configurationError(
        'Saved delegation launch snapshot does not match the review',
        'DELEGATION_ADMISSION_CORRUPT',
        500,
      );
    return { podId, created, config, plan, checkpoint };
  };
  const replay = snapshots.findRequest(request.requestId, requestDigest);
  if (replay) return receipt(replay, false);

  const { config, plan, assertCurrent } = await prepareSavedDelegationLaunch({
    ...input,
    request,
    principal,
  });
  const raw = await input.readSeedBundle(structuredClone(plan));
  if (!Buffer.isBuffer(raw) || raw.length < 1 || raw.length > MAX_CANDIDATE_BYTES)
    configurationError(
      'Saved delegation seed bundle is outside custody limits',
      'DELEGATION_SEED_INVALID',
      409,
    );
  const bundle = Buffer.from(raw);
  if (sha256(bundle) !== plan.pins.source.bundleDigest)
    configurationError('Seed bundle changed after review', 'DELEGATION_SEED_INVALID', 409);
  const { manifest, checkpoint } = describeSeed(plan);
  await withVerifiedCheckpointMirror(input.scratch, checkpoint, bundle, async () => {});

  const db = input.db;
  const result = snapshots.admit({
    config,
    requestId: request.requestId,
    requestDigest,
    createPod: () => {
      assertCurrent();
      const podId = input.insertPod(config);
      assertCurrent();
      if (db.prepare('SELECT user_id FROM pods WHERE id=?').pluck().get(podId) !== principal.oid)
        configurationError(
          'Saved delegation requires the exact Task owner',
          'DELEGATION_OWNER_REQUIRED',
          403,
        );
      db.prepare(`INSERT INTO orchestration_runs(id,repository,policy_digest,accepted_commit,worker_request_limit,max_active,operator_owned)
        VALUES(?,?,?,?,?,?,1)`).run(
        plan.runId,
        checkpoint.repository,
        checkpoint.policyDigest,
        checkpoint.predecessor,
        plan.workerModelRequests,
        plan.policy.maxConcurrentWorkers,
      );
      db.prepare(`INSERT INTO orchestration_checkpoint_custody(run_id,evidence_digest,manifest,bundle)
        VALUES(?,?,?,?)`).run(plan.runId, checkpoint.evidenceDigest, manifest, bundle);
      db.prepare(`INSERT INTO parent_managed_runs(run_id,pod_id,launch_digest,policy_digest,policy_json)
        VALUES(?,?,?,?,?)`).run(
        plan.runId,
        podId,
        config.digest,
        checkpoint.policyDigest,
        canonical(plan),
      );
      db.prepare(`INSERT INTO saved_delegation_admissions(run_id,request_id,owner_digest,plan_digest,seed_evidence_digest)
        VALUES(?,?,?,?,?)`).run(
        plan.runId,
        plan.requestId,
        owner,
        plan.digest,
        checkpoint.evidenceDigest,
      );
      return podId;
    },
  });
  return receipt(result.podId, result.created);
}
