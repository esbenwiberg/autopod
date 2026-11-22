import type { KeyObject } from 'node:crypto';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import type { ManagedAcceptanceRuntime } from '../managed/acceptance-config.js';
import { canonical, digest, sha256 } from '../managed/canonical.js';
import type { ManagedCliConfig } from '../managed/cli-config.js';
import type { ManagedContainerRuntime } from '../managed/container-runtime.js';
import {
  admitManagedRequest,
  REQUIRED_ENFORCEMENT,
  validateManagedRequest,
} from '../managed/grants.js';
import {
  assertPrivateParentCommit,
  isPrivateParentCommit,
} from '../managed/private-commit-policy.js';
import {
  type ManagedProfileSetConfig,
  profileSetRequestPolicy,
} from '../managed/profile-set-config.js';
import { MAX_CANDIDATE_BYTES } from '../managed/source-git.js';
import type { ProfileLlmClient } from '../providers/llm-client.js';
import {
  combinedPolicyDigest,
  gatePinsSchema,
  gatePolicySchema,
  signedGateSchema,
  verifyGateReceipt,
} from './combined-attestation.js';
import type { ContinuationCheckpoint } from './continuations.js';
import type { MainProfilePin } from './hosted-controller-profile.js';
import { type bindInspectionCodex, inspectionCodexPin } from './inspection-codex.js';
import { LocalCheckpointHost } from './local-checkpoints.js';
import { type OperatorRunsConfig, operatorRunId } from './operator-runs.js';
import { createParentEvaluatorClient } from './parent-evaluator-client.js';
import { createEvaluatorDispatchSigner } from './parent-evaluator-dispatch.js';
import { composeParentHostGates, type ParentHostGatePorts } from './parent-host-gates.js';
import type { ParentIntegrationGates } from './parent-integration-qualified.js';
import { parentLaunchPolicySchema } from './parent-managed-launch.js';
import { parentPrivateCompletion } from './parent-private-completion.js';
import { parentQualificationJob } from './parent-qualification-job.js';

const id = z.string().min(1).max(160),
  alias = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
  hash = z.string().regex(/^sha256:[a-f0-9]{64}$/),
  oid = z.string().regex(/^[a-f0-9]{40}$/);
const schema = z
  .object({
    version: z.literal(1),
    parent: parentLaunchPolicySchema.optional(),
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
    return enrollmentSchema.parse(JSON.parse(raw));
  } catch {
    throw new Error('invalid-operator-enrollment');
  }
}
export const operatorDraftSchema = schema
  .omit({ authorities: true, checks: true, review: true })
  .extend({ main: z.union([schema.shape.main, inspectionCodexPin]) });
// A fresh, separately commissioned task needs a new run identity, never a reset
// of an old slot's reservations. Only the daemon can enroll these names.
const inspectionSlot = /^inspection(?:-[1-9][0-9]{0,7})?$/;
const ownerInspectionSchema = operatorDraftSchema.extend({
  parent: z.never().optional(),
  version: z.literal(2),
  slot: z.string().regex(inspectionSlot),
  expectedRun: z.string().regex(/^[a-f0-9]{64}$/),
  expectedBasePolicy: hash,
});
const enrollmentSchema = z.discriminatedUnion('version', [schema, ownerInspectionSchema]);
type Draft = Omit<z.infer<typeof operatorDraftSchema>, 'version'>;
type Envelope = z.infer<typeof enrollmentSchema>;
type Runtime = ManagedAcceptanceRuntime & {
  privateRuntime?: ManagedContainerRuntime;
  sandboxCoding?: { resourceScopeDigest: string; readyDiskImageId: string };
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
  e: Pick<Envelope, 'main' | 'mission' | 'budget' | 'recipes' | 'source' | 'parent'>,
  profiles: ManagedProfileSetConfig,
  isolatedArtifacts = false,
) {
  return digest([
    'autopod.operator-envelope.v1',
    e.main,
    e.mission,
    e.budget,
    e.recipes,
    e.source.bundleDigest,
    profiles,
    ...(isolatedArtifacts ? ['local-operator-artifacts/v1'] : []),
    ...(e.parent ? [['parent-managed/v1', e.parent]] : []),
  ]);
}
/** Refuse to orphan a commissioned run or silently reattach its workers to a different
 * enrollment. Canceled, fully cleaned history can be retained with the feature off. */
export function assertOperatorRecovery(db: Database.Database, run: string | null) {
  const missing = db
    .prepare(`SELECT 1 FROM orchestration_runs r WHERE r.operator_owned=1 AND r.id IS NOT ?
 AND ( (r.canceled=0 AND EXISTS(SELECT 1 FROM orchestration_kickoffs k WHERE k.run_id=r.id))
 OR EXISTS(SELECT 1 FROM managed_pods p WHERE p.dispatcher_installation_id='native.'||r.id AND (p.observed_exit=0 OR (p.runtime_ref IS NOT NULL AND p.cleanup<>'observed')))) LIMIT 1`)
    .get(run);
  if (missing) throw new Error('operator-enrollment-required-for-recovery');
}
export function enrolledOperator(
  e: Pick<Draft, 'objectId'>,
  cli: ManagedCliConfig,
  profiles: ManagedProfileSetConfig,
) {
  const owners = cli.bindings.filter(
    (b) => b.objectId === e.objectId && b.installationId === profiles.installationId,
  );
  if (owners.length !== 1 || !owners[0]) throw new Error('operator-binding-required');
  return owners[0];
}

export function confinedCatalog(e: Draft, profiles: ManagedProfileSetConfig) {
  const target = profiles.profiles[0]?.profileSnapshot.route.executionTarget;
  const catalog = Object.fromEntries(
    Object.entries(e.recipes).map(([k, v]) => [k, validateManagedRequest(v)]),
  );
  if (!Object.keys(catalog).length || Object.keys(catalog).length > 16)
    throw new Error('invalid-operator-catalog');
  const coding = e.parent?.coding;
  const codingStages = profiles.profiles.filter((stage) => stage.privateCommit);
  const paths = [...(coding?.paths ?? []), ...(coding?.sandbox?.secondPaths ?? [])];
  const lower = paths.map((name) => name.toLowerCase());
  if (
    coding
      ? codingStages.length !== 1 ||
        !Object.hasOwn(catalog, coding.recipe) ||
        profiles.source ||
        profiles.githubRead ||
        profiles.mirror.dependencyCachePath ||
        (target === 'sandbox') !== Boolean(coding.sandbox) ||
        (coding.sandbox &&
          (Boolean(coding.evaluation) === Boolean(coding.sandbox.hostQualification) ||
            (coding.sandbox.hostQualification && coding.sandbox.authorizeEvaluatorDispatch) ||
            (coding.sandbox.singleOwnerReceipts && !coding.sandbox.hostQualification) ||
            e.budget.workers < 2 ||
            lower.some((name, index) =>
              lower.some(
                (other, j) => j !== index && (name === other || name.startsWith(other + '/')),
              ),
            ))) ||
        paths.some((name) => name.split('/').some((part) => part.endsWith('.')))
      : codingStages.length !== 0
  )
    throw new Error('parent-coding-policy-mismatch');
  for (const [alias, r] of Object.entries(catalog)) {
    profileSetRequestPolicy(profiles)(r);
    if (alias === coding?.recipe) {
      assertPrivateParentCommit(
        r,
        profiles.mirror.enrollmentId,
        e.source.commit,
        coding.sandbox ? 'sandbox' : 'local',
      );
      continue;
    }
    if (isPrivateParentCommit(r)) throw new Error('parent-coding-policy-mismatch');
    const scope = r.effectiveGrant.scope;
    if (
      r.route.executionTarget !== target ||
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
  return catalog;
}

// Validate immutable confinement on recovery as well as first install. Live
// expiry is enforced by worker preflight on first kickoff and by the provider.
export function inspectionPolicy(draft: Draft, profiles: ManagedProfileSetConfig, now: number) {
  const cases = profiles.profiles.some((s) => s.caseDirectory);
  const names = profiles.profiles.map((s) => s.caseDirectory?.toLowerCase());
  if (
    cases &&
    (!inspectionCodexPin.safeParse(draft.main).success ||
      profiles.profiles.length > 6 ||
      names.some((x) => !x) ||
      new Set(names).size !== names.length ||
      canonical([...Object.keys(draft.recipes)].sort()) !== canonical([...names].sort()))
  )
    throw new Error('inspection-case-binding');
  if (
    profiles.catalogArtifacts ||
    profiles.source ||
    profiles.githubRead ||
    profiles.mirror.dependencyCachePath ||
    (!cases && profiles.profiles.length !== 1) ||
    profiles.profiles[0]?.profileSnapshot.route.executionTarget !== 'sandbox'
  )
    throw new Error('inspection-profile-scope');
  if (
    !inspectionSlot.test(draft.slot) ||
    draft.budget.requests > 18 ||
    draft.budget.active > 6 ||
    (!cases && Object.keys(draft.recipes).join(',') !== 'inspect') ||
    (!inspectionCodexPin.safeParse(draft.main).success &&
      canonical(draft.main) !==
        canonical({
          profileName: 'repofit',
          profileId: 'profile-f3ec3b28e6369a8879e2a1da',
          profileRevision: 2,
          aiId: 'ai-2aa5da9e201c0adf52150c71',
          aiRevision: 8,
          accountId: 'anth-pro',
          model: 'claude-sonnet-5-5',
        }))
  )
    throw new Error('inspection-run-scope');
  const catalog = confinedCatalog(draft, profiles);
  for (const stage of profiles.profiles) {
    const req = catalog[stage.caseDirectory?.toLowerCase() ?? 'inspect'];
    if (!req) throw new Error('inspection-recipe-required');
    const snap = stage.profileSnapshot;
    if (req.profileSnapshot.snapshotDigest !== snap.snapshotDigest)
      throw new Error('inspection-case-binding');
    if (
      canonical(snap.scope) !== canonical(req.effectiveGrant.scope) ||
      snap.route.runtime !== 'codex' ||
      req.outputs.artifacts.limits.maxFiles !== 1 ||
      req.outputs.artifacts.limits.maxTotalBytes > 16384
    )
      throw new Error('inspection-report-scope');
    if (
      !('maxProviderRequests' in snap.budget) ||
      snap.budget.maxProviderRequests > 2 ||
      !('maxProviderRequests' in req.effectiveGrant.budget) ||
      req.effectiveGrant.budget.maxProviderRequests > 2
    )
      throw new Error('inspection-worker-budget');
    admitManagedRequest(
      req,
      {
        targets: ['sandbox'],
        profiles: new Map([[snap.snapshotDigest, snap]]),
        enrollmentCeiling: snap.scope,
        identityCeiling: snap.scope,
        backendCeiling: snap.scope,
        enforcement: REQUIRED_ENFORCEMENT,
      },
      now,
    );
  }
  return catalog;
}

export function composeOperatorEnrollment(
  e: Envelope,
  deps: {
    db: Database.Database;
    databasePath: string;
    isolatedArtifacts?: boolean;
    profiles: ManagedProfileSetConfig | undefined;
    cli: ManagedCliConfig | undefined;
    runtime: Runtime | undefined;
    /** Private role-scoped TLS for dynamic dispatch; harnesses may inject a local test port. */
    evaluatorFetch?: typeof fetch;
    trustedEvaluatorPins?: unknown;
    /** Explicit trusted host composition. Never loaded from worker JSON or a provider response. */
    parentHostGates?: ParentHostGatePorts;
    evaluatorDispatchKeys?: Readonly<Record<'checks' | 'independentReview', KeyObject>>;
    bind: (pin: MainProfilePin) => ProfileLlmClient;
    bindCodex?: (pin: z.infer<typeof inspectionCodexPin>) => ReturnType<typeof bindInspectionCodex>;
  },
): OperatorRunsConfig {
  const { profiles, cli, runtime, db } = deps;
  const target = profiles?.profiles[0]?.profileSnapshot.route.executionTarget;
  if (
    !profiles ||
    !cli ||
    !runtime ||
    runtime.config.db !== db ||
    profiles.catalogArtifacts ||
    (target !== 'local' && !(deps.isolatedArtifacts && target === 'sandbox')) ||
    profiles.profiles.some((s) => s.profileSnapshot.route.executionTarget !== target)
  )
    throw new Error('operator-local-profile-set-required');
  const operator = enrolledOperator(e, cli, profiles);
  const run = operatorRunId(operator, e.slot);
  if (e.version === 2 && !deps.isolatedArtifacts)
    throw new Error('inspection-private-storage-required');
  const cases = profiles.profiles.some((stage) => stage.caseDirectory);
  if (cases && e.version !== 2) throw new Error('inspection-case-owner-required');
  const catalog = e.version === 2 ? inspectionPolicy(e, profiles, 0) : confinedCatalog(e, profiles);
  if (e.parent?.coding && (!runtime.privateRuntime || !deps.isolatedArtifacts))
    throw new Error('parent-private-runtime-partition-required');
  const sandboxCoding = e.parent?.coding?.sandbox;
  if (sandboxCoding) {
    if (
      e.version !== 1 ||
      runtime.sandboxCoding?.resourceScopeDigest !== sandboxCoding.resourceScopeDigest ||
      runtime.sandboxCoding.readyDiskImageId !== sandboxCoding.readyDiskImageId
    )
      throw new Error('parent-sandbox-coding-runtime-mismatch');
    const pins = gatePinsSchema.safeParse(deps.trustedEvaluatorPins);
    if (
      !pins.success ||
      canonical(pins.data.checks) !== canonical(e.authorities.checks) ||
      canonical(pins.data.independentReview) !== canonical(e.authorities.independentReview)
    )
      throw new Error('independently-provisioned-public-policy-required');
  }
  const hostQualification = sandboxCoding?.hostQualification === true;
  if (hostQualification !== Boolean(deps.parentHostGates))
    throw new Error('parent-host-qualification-binding-required');
  if (
    Boolean(sandboxCoding?.singleOwnerReceipts) !==
    (deps.parentHostGates?.receiptTrust === 'single-owner-local')
  )
    throw new Error('parent-host-receipt-mode-mismatch');
  if (hostQualification && deps.evaluatorDispatchKeys)
    throw new Error('parent-host-qualification-remote-dispatch-refused');
  const requireDispatch = sandboxCoding?.authorizeEvaluatorDispatch === true;
  const dispatch =
    requireDispatch && e.version === 1 && deps.evaluatorDispatchKeys
      ? createEvaluatorDispatchSigner(deps.evaluatorDispatchKeys, e.authorities)
      : undefined;
  if (requireDispatch && !dispatch) throw new Error('parent-evaluator-dispatch-key-required');
  if (requireDispatch && !deps.evaluatorFetch)
    throw new Error('parent-evaluator-tls-credentials-required');
  const base = operatorBasePolicy(e, profiles, deps.isolatedArtifacts);
  if (e.version === 2 && (run !== e.expectedRun || base !== e.expectedBasePolicy))
    throw new Error('inspection-preflight-binding-mismatch');
  if (e.version === 1 && e.authorities.basePolicyDigest !== base)
    throw new Error('operator-policy-mismatch');
  const policyDigest =
    e.version === 1
      ? combinedPolicyDigest(e.authorities)
      : digest(['authenticated-inspection/v2', base]);
  const subject = {
    run,
    repository: profiles.mirror.enrollmentId,
    policyDigest,
    predecessor: e.source.predecessor,
    commit: e.source.commit,
    tree: e.source.tree,
  };
  const input = operatorSeedInput(subject, e.source.bundleDigest);
  const verification =
    e.version === 1
      ? {
          subjectDigest: digest(subject),
          checks: verifyGateReceipt(e.authorities, 'checks', input, e.checks),
          independentReview: verifyGateReceipt(e.authorities, 'independentReview', input, e.review),
        }
      : undefined;
  const manifest = canonical({
    version: 1,
    origin: verification ? 'operator-enrollment/v1' : 'owner-inspection/v2',
    subject,
    bundleDigest: e.source.bundleDigest,
    ...(verification ? { verification } : {}),
  });
  const checkpoint = { ...subject, evidenceDigest: sha256(manifest) };
  const host = new LocalCheckpointHost(
    db,
    path.join(path.dirname(path.resolve(deps.databasePath)), 'managed', 'checkpoints'),
    runtime,
    e.version === 2 ? checkpoint.evidenceDigest : undefined,
    profiles.profiles.flatMap((stage) => (stage.caseDirectory ? [stage.caseDirectory] : [])),
  );
  const codex = 'kind' in e.main;
  const provider = e.parent
    ? undefined
    : 'kind' in e.main
      ? deps.bindCodex?.(e.main)
      : deps.bind(e.main);
  if (!provider && !e.parent) throw new Error('inspection-codex-binding-required');
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
      const retained = await host.retain(
        subject,
        bytes,
        verification ? async () => verification : null,
        {
          requests: e.budget.requests,
          active: e.budget.active,
        },
      );
      if (retained.evidenceDigest !== checkpoint.evidenceDigest)
        throw new Error('operator-custody-changed');
    }
    if (e.parent?.coding) {
      if (
        !runtime.privateRuntime ||
        !runtime.components.service.ownsInstallation('native.' + run) ||
        runtime.components.service.privateCommit
      )
        throw new Error('parent-private-runtime-partition-required');
      runtime.components.service.privateCommit = parentPrivateCompletion(
        runtime.components.service,
        runtime.privateRuntime,
        path.join(path.dirname(deps.databasePath), 'managed', 'parent-private-candidates'),
        checkpoint,
        e.parent.coding.paths,
        qualification?.reserve,
        sandboxCoding?.secondPaths,
      );
    }
    await runtime.resume();
  };
  const coding = e.parent?.coding;
  const scratch = path.join(
    path.dirname(path.resolve(deps.databasePath)),
    'managed',
    'parent-qualification',
  );
  let gates: ParentIntegrationGates | undefined;
  if (e.version === 1 && coding) {
    if (hostQualification && deps.parentHostGates) {
      gates = composeParentHostGates(
        {
          db,
          scratch,
          run,
          policy: e.authorities,
          // Deny these accounts for review; a recipe never grants reviewer access.
          excludedReviewerAccounts: Object.values(catalog).map(
            (recipe) => recipe.route.providerAccountId,
          ),
        },
        deps.parentHostGates,
      );
    } else if (coding.evaluation) {
      gates = createParentEvaluatorClient(
        coding.evaluation,
        e.authorities,
        deps.evaluatorFetch,
        dispatch,
      );
    }
  }
  const qualification =
    coding && gates
      ? parentQualificationJob(
          db,
          host,
          scratch,
          run,
          coding.paths,
          gates,
          sandboxCoding?.secondPaths,
        )
      : undefined;
  return {
    host,
    db,
    prepare,
    qualification,
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
        ...(e.parent ? { parent: e.parent } : {}),
        policy: {
          mission: e.mission,
          routeId: codex ? 'inspection-codex-v1' : 'hosted-main',
          findings: cases ? 'required-case-report/v1' : 'report.md',
          recipes: Object.fromEntries(Object.keys(catalog).map((k) => [k, '@' + k])),
          limits: {
            turns: e.budget.turns,
            workers: e.budget.workers,
            outputTokens: codex ? 'request-time-30s' : 512,
          },
        },
      },
    ],
  };
}
