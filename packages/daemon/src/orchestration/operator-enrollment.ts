import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import type { ManagedAcceptanceRuntime } from '../managed/acceptance-config.js';
import { canonical, digest, sha256 } from '../managed/canonical.js';
import type { ManagedCliConfig } from '../managed/cli-config.js';
import { validateManagedRequest } from '../managed/grants.js';
import {
  type ManagedProfileSetConfig,
  profileSetRequestPolicy,
} from '../managed/profile-set-config.js';
import { MAX_CANDIDATE_BYTES } from '../managed/source-git.js';
import type { ProfileLlmClient } from '../providers/llm-client.js';
import {
  combinedPolicyDigest,
  gatePolicySchema,
  signedGateSchema,
  verifyGateReceipt,
} from './combined-attestation.js';
import type { ContinuationCheckpoint } from './continuations.js';
import type { MainProfilePin } from './hosted-controller-profile.js';
import { LocalCheckpointHost } from './local-checkpoints.js';
import { type OperatorRunsConfig, operatorRunId } from './operator-runs.js';

const id = z.string().min(1).max(160),
  alias = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
  hash = z.string().regex(/^sha256:[a-f0-9]{64}$/),
  oid = z.string().regex(/^[a-f0-9]{40}$/);
const schema = z
  .object({
    version: z.literal(1),
    slot: alias,
    objectId: id,
    mission: z.string().trim().min(1).max(4096),
    main: z
      .object({
        profileName: id,
        profileId: id,
        profileRevision: z.number().int().positive(),
        aiId: id,
        aiRevision: z.number().int().positive(),
        model: id,
        accountId: id,
      })
      .strict(),
    budget: z
      .object({
        requests: z.number().int().min(1).max(1024),
        active: z.number().int().min(1).max(8),
        workers: z.number().int().min(1).max(8),
        turns: z.number().int().min(1).max(2),
      })
      .strict(),
    recipes: z.record(alias, z.unknown()),
    source: z
      .object({
        predecessor: oid,
        commit: oid,
        tree: oid,
        bundleDigest: hash,
        bundlePath: z.string().max(4096).refine(path.isAbsolute),
      })
      .strict(),
    authorities: gatePolicySchema,
    checks: signedGateSchema,
    review: signedGateSchema,
  })
  .strict();
export function parseOperatorEnrollment(raw: string | undefined) {
  if (raw === undefined) return undefined;
  try {
    if (Buffer.byteLength(raw) > 256 * 1024) throw new Error();
    return schema.parse(JSON.parse(raw));
  } catch {
    throw new Error('invalid-operator-enrollment');
  }
}
type Envelope = z.infer<typeof schema>;
type Runtime = ManagedAcceptanceRuntime & {
  withCheckpoint<T>(
    cp: Readonly<ContinuationCheckpoint>,
    mirror: string,
    use: (s: ManagedAcceptanceRuntime['components']['service']) => Promise<T>,
  ): Promise<T>;
};
/** Non-secret evaluator input; independent checks and review sign this digest, not a path. */
export function operatorSeedInput(
  subject: Omit<ContinuationCheckpoint, 'evidenceDigest'>,
  bundleDigest: string,
) {
  return digest(['autopod.operator-seed.v1', subject, bundleDigest]);
}
export function operatorBasePolicy(
  e: Pick<Envelope, 'main' | 'mission' | 'budget' | 'recipes' | 'source'>,
  profiles: ManagedProfileSetConfig,
) {
  return digest([
    'autopod.operator-envelope.v1',
    e.main,
    e.mission,
    e.budget,
    e.recipes,
    e.source.bundleDigest,
    profiles,
  ]);
}
/** Refuse to orphan a commissioned run or silently reattach its workers to a different
 * enrollment. Canceled, fully cleaned history can be retained with the feature off. */
export function assertOperatorRecovery(db: Database.Database, run: string | null) {
  const missing = db
    .prepare(`SELECT 1 FROM orchestration_runs r WHERE EXISTS(SELECT 1 FROM orchestration_checkpoint_custody c WHERE c.run_id=r.id AND json_extract(c.manifest,'$.origin')='operator-enrollment/v1') AND r.id IS NOT ?
 AND ( (r.canceled=0 AND EXISTS(SELECT 1 FROM orchestration_kickoffs k WHERE k.run_id=r.id))
 OR EXISTS(SELECT 1 FROM managed_pods p WHERE p.dispatcher_installation_id='native.'||r.id AND (p.observed_exit=0 OR (p.runtime_ref IS NOT NULL AND p.cleanup<>'observed')))) LIMIT 1`)
    .get(run);
  if (missing) throw new Error('operator-enrollment-required-for-recovery');
}
export function composeOperatorEnrollment(
  e: Envelope,
  deps: {
    db: Database.Database;
    databasePath: string;
    profiles: ManagedProfileSetConfig | undefined;
    cli: ManagedCliConfig | undefined;
    runtime: Runtime | undefined;
    bind: (pin: MainProfilePin) => ProfileLlmClient;
  },
): OperatorRunsConfig {
  const { profiles, cli, runtime, db } = deps;
  if (
    !profiles ||
    !cli ||
    !runtime ||
    runtime.config.db !== db ||
    profiles.catalogArtifacts ||
    profiles.profiles.some((s) => s.profileSnapshot.route.executionTarget !== 'local')
  )
    throw new Error('operator-local-profile-set-required');
  const owners = cli.bindings.filter(
    (b) => b.objectId === e.objectId && b.installationId === profiles.installationId,
  );
  const operator = owners[0];
  if (!operator || owners.length !== 1) throw new Error('operator-binding-required');
  const run = operatorRunId(operator, e.slot);
  const host = new LocalCheckpointHost(
    db,
    path.join(path.dirname(path.resolve(deps.databasePath)), 'managed', 'checkpoints'),
    runtime,
  );
  const catalog = Object.fromEntries(
    Object.entries(e.recipes).map(([k, v]) => [k, validateManagedRequest(v)]),
  );
  if (!Object.keys(catalog).length || Object.keys(catalog).length > 16)
    throw new Error('invalid-operator-catalog');
  for (const r of Object.values(catalog)) {
    profileSetRequestPolicy(profiles)(r);
    const scope = r.effectiveGrant.scope;
    if (
      r.route.executionTarget !== 'local' ||
      r.route.runtime !== 'codex' ||
      r.outputs.source.mode !== 'none' ||
      r.outputs.artifacts.mode !== 'required' ||
      canonical(r.outputs.artifacts.requiredPaths) !== canonical(['report.md']) ||
      r.inputArtifacts.length ||
      scope.repositories.length !== 1 ||
      scope.repositories[0]?.access !== 'read' ||
      scope.repositories[0].baseRevision !== e.source.commit ||
      scope.network.destinations.length ||
      scope.identityBindings.length ||
      scope.allowedEffects.some((x) => !['artifact.write', 'repository.read'].includes(x))
    )
      throw new Error('operator-recipe-not-confined');
  }
  if (e.source.commit !== profiles.mirror.baseRevision) throw new Error('operator-source-mismatch');
  if (e.authorities.basePolicyDigest !== operatorBasePolicy(e, profiles))
    throw new Error('operator-policy-mismatch');
  const policyDigest = combinedPolicyDigest(e.authorities);
  const subject = {
    run,
    repository: profiles.mirror.enrollmentId,
    policyDigest,
    predecessor: e.source.predecessor,
    commit: e.source.commit,
    tree: e.source.tree,
  };
  const input = operatorSeedInput(subject, e.source.bundleDigest);
  const verification = {
    subjectDigest: digest(subject),
    checks: verifyGateReceipt(e.authorities, 'checks', input, e.checks),
    independentReview: verifyGateReceipt(e.authorities, 'independentReview', input, e.review),
  };
  const manifest = canonical({
    version: 1,
    origin: 'operator-enrollment/v1',
    subject,
    bundleDigest: e.source.bundleDigest,
    verification,
  });
  const checkpoint = { ...subject, evidenceDigest: sha256(manifest) };
  const provider = deps.bind(e.main);
  const prepare = async () => {
    assertOperatorRecovery(db, run);
    const prior = db
      .prepare(
        'SELECT policy_digest,repository,worker_request_limit,max_active FROM orchestration_runs WHERE id=?',
      )
      .get(run) as
      | {
          policy_digest: string;
          repository: string;
          worker_request_limit: number;
          max_active: number;
        }
      | undefined;
    if (
      prior &&
      (prior.policy_digest !== policyDigest ||
        prior.repository !== subject.repository ||
        prior.worker_request_limit !== e.budget.requests ||
        prior.max_active !== e.budget.active)
    )
      throw new Error('operator-enrollment-changed');
    const previous = db
      .prepare(
        'SELECT manifest,bundle FROM orchestration_checkpoint_custody WHERE run_id=? AND evidence_digest=?',
      )
      .get(run, checkpoint.evidenceDigest) as { manifest: string; bundle: Buffer } | undefined;
    if (previous) {
      if (previous.manifest !== manifest || sha256(previous.bundle) !== e.source.bundleDigest)
        throw new Error('operator-custody-damaged');
    } else {
      const fd = await open(
        e.source.bundlePath,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      let bytes: Buffer;
      try {
        const stat = await fd.stat();
        if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_CANDIDATE_BYTES)
          throw new Error('operator-seed-size');
        bytes = Buffer.alloc(stat.size);
        let pos = 0;
        while (pos < bytes.length) {
          const r = await fd.read(bytes, pos, bytes.length - pos, pos);
          if (!r.bytesRead) throw new Error('operator-seed-short');
          pos += r.bytesRead;
        }
      } finally {
        await fd.close();
      }
      if (sha256(bytes) !== e.source.bundleDigest) throw new Error('operator-seed-damaged');
      if (prior) throw new Error('operator-custody-missing');
      const retained = await host.retain(subject, bytes, async () => verification, {
        requests: e.budget.requests,
        active: e.budget.active,
      });
      if (retained.evidenceDigest !== checkpoint.evidenceDigest)
        throw new Error('operator-custody-changed');
    }
    await runtime.resume();
  };
  return {
    host,
    db,
    prepare,
    cleanup: async (id) => {
      if (
        id !== run ||
        db.prepare('SELECT canceled FROM orchestration_runs WHERE id=?').pluck().get(run) !== 1
      )
        throw new Error('operator-cleanup-requires-cancel');
      const owner = 'native.' + run;
      const rows = db
        .prepare(
          'SELECT pod_id,dispatcher_attempt_id,grant_id,grant_revision,observed_exit FROM managed_pods WHERE dispatcher_installation_id=? ORDER BY rowid',
        )
        .all(owner) as {
        pod_id: string;
        dispatcher_attempt_id: string;
        grant_id: string;
        grant_revision: number;
        observed_exit: number;
      }[];
      if (rows.some((r) => !r.observed_exit)) throw new Error('operator-worker-exit-unverified');
      for (const r of rows) {
        const receipt = await runtime.components.controls.control(
          owner,
          r.pod_id,
          {
            schemaVersion: 1,
            dispatcherAttemptId: r.dispatcher_attempt_id,
            grantId: r.grant_id,
            grantRevision: r.grant_revision,
            operation: 'cleanup',
          },
          'operator-cleanup-v1',
        );
        if (receipt.cleanup !== 'observed') throw new Error('operator-cleanup-unverified');
      }
      return { run, cleaned: rows.length };
    },
    slots: [
      {
        slot: e.slot,
        operator,
        checkpoint,
        catalog,
        provider,
        policy: {
          mission: e.mission,
          routeId: 'hosted-main',
          findings: 'report.md',
          recipes: Object.fromEntries(Object.keys(catalog).map((k) => [k, '@' + k])),
          limits: { turns: e.budget.turns, workers: e.budget.workers, outputTokens: 512 },
        },
      },
    ],
  };
}
