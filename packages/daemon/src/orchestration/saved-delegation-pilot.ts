import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath } from 'node:fs/promises';
import path from 'node:path';
import type { EffectiveLaunchConfig, RepositoryConfig } from '@autopod/shared';
import type Database from 'better-sqlite3';
import type { Logger } from 'pino';
import { z } from 'zod';
import { configurationError } from '../configuration/configuration-store.js';
import { configurationDigest } from '../configuration/launch-resolver.js';
import type { SavedDelegationLaunchHost } from '../configuration/saved-delegation-launch-lane.js';
import type { PodTokenIssuer } from '../crypto/pod-tokens.js';
import { chatGptCredential } from '../managed/acceptance-config.js';
import { canonical, digest, sha256 } from '../managed/canonical.js';
import { validateManagedRequest } from '../managed/grants.js';
import {
  assertPrivateParentCommit,
  isPrivateSubmission,
  PRIVATE_SUBMISSION_FILE,
} from '../managed/private-commit-policy.js';
import {
  composeManagedProfileSet,
  parseManagedProfileSetConfig,
  profileSetRequestPolicy,
} from '../managed/profile-set-config.js';
import { MAX_CANDIDATE_BYTES, managedGit } from '../managed/source-git.js';
import { combinedPolicyDigest, gatePinsSchema, gatePolicySchema } from './combined-attestation.js';
import { withVerifiedCheckpointMirror } from './local-checkpoints.js';
import { composeOperatorSandboxTarget } from './operator-sandbox-target.js';
import {
  createParentEvaluatorClient,
  parentEvaluatorEndpointsSchema,
} from './parent-evaluator-client.js';
import {
  createEvaluatorDispatchSigner,
  readEvaluatorDispatchKeys,
} from './parent-evaluator-dispatch.js';
import { enrollParentEvaluators } from './parent-evaluator-enrollment.js';
import { requireEvaluatorReadiness } from './parent-evaluator-readiness.js';
import { loadParentEvaluatorTlsFetch } from './parent-evaluator-tls.js';
import {
  readSavedDelegationAdmission,
  savedDelegationGatePolicy,
} from './saved-delegation-admission.js';
import {
  createSavedDelegationPolicyStore,
  delegationPin,
  savedDelegationPolicySchema,
} from './saved-delegation-policy.js';
import { attachSavedDelegationRuntime } from './saved-delegation-runtime.js';

const gitId = z.string().regex(/^[a-f0-9]{40}$/);
const pilotSchema = z
  .object({
    version: z.literal(1),
    owner: z
      .object({
        oid: z.uuid(),
        iss: z.url().startsWith('https://'),
        aud: z.string().min(1).max(160),
      })
      .strict(),
    policyId: z.uuid(),
    policy: savedDelegationPolicySchema,
    repositoryDigest: z.string().regex(/^[a-f0-9]{64}$/),
    source: z
      .object({
        predecessor: gitId,
        commit: gitId,
        tree: gitId,
        bundleDigest: delegationPin,
        bundlePath: z.string().max(4096).refine(path.isAbsolute),
        resultTransport: z.literal('anchored/v1').optional(),
      })
      .strict(),
    sandbox: z
      .object({
        resourceScopeDigest: delegationPin,
        readyDiskImageId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
      })
      .strict(),
    profiles: z.unknown(),
    recipes: z.record(z.string(), z.unknown()),
    endpoints: parentEvaluatorEndpointsSchema,
    evaluatorEnrollment: z.literal('automatic').optional(),
    authorities: gatePinsSchema,
  })
  .strict();

/** Private service-owned files, never a client-supplied path. Refuse symlinks,
 * devices, growth/truncation, and material readable by group or other users. */
async function readPrivatePilotFile(file: string, maximumBytes: number): Promise<Buffer> {
  const dir = path.dirname(file);
  const trusted = (uid: number) => uid === 0 || uid === process.getuid?.();
  const directory = await lstat(dir);
  if (
    !directory.isDirectory() ||
    (directory.mode & 0o077) !== 0 ||
    !trusted(directory.uid) ||
    (await realpath(dir)) !== dir
  )
    throw new Error('saved-delegation-pilot-directory-refused');
  const fd = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await fd.stat();
    if (
      !stat.isFile() ||
      (stat.mode & 0o077) !== 0 ||
      !trusted(stat.uid) ||
      stat.size < 1 ||
      stat.size > maximumBytes
    )
      throw new Error('saved-delegation-pilot-file-refused');
    const data = Buffer.alloc(stat.size + 1);
    let offset = 0;
    while (offset < data.length) {
      const { bytesRead } = await fd.read(data, offset, data.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    if (offset !== stat.size) throw new Error('saved-delegation-pilot-file-changed');
    return data.subarray(0, offset);
  } finally {
    await fd.close();
  }
}

/** No provider, repository, or Azure calls. Inspect the exact operator-owned
 * inputs and the pinned Git object graph before installing the pilot. */
export async function readSavedDelegationPilot(file: string, scratch: string) {
  if (!path.isAbsolute(file) || path.normalize(file) !== file)
    throw new Error('saved-delegation-pilot-path-refused');
  const spec = pilotSchema.parse(
    JSON.parse(
      await readPrivatePilotFile(file, 512 * 1024).then((bytes) => bytes.toString('utf8')),
    ),
  );
  if (
    path.dirname(spec.source.bundlePath) !== path.dirname(file) ||
    (spec.source.resultTransport && spec.evaluatorEnrollment !== 'automatic') ||
    spec.authorities.checks.configurationDigest !== spec.policy.checksDigest ||
    spec.authorities.independentReview.configurationDigest !== spec.policy.reviewer.policyDigest ||
    !gatePolicySchema.safeParse({ ...spec.authorities, basePolicyDigest: digest(spec.policy) })
      .success
  )
    throw new Error('saved-delegation-pilot-policy-refused');
  const profiles = parseManagedProfileSetConfig(JSON.stringify(spec.profiles));
  if (
    !profiles ||
    profiles.source ||
    profiles.githubRead ||
    profiles.catalogArtifacts ||
    profiles.mirror.dependencyCachePath ||
    profiles.mirror.enrollmentId !== spec.policy.repositoryId ||
    profiles.mirror.baseRevision !== spec.source.commit ||
    profiles.mirror.remote !== 'private' ||
    profiles.profiles.some(
      (stage) =>
        !stage.privateCommit ||
        stage.artifactPath !== PRIVATE_SUBMISSION_FILE ||
        stage.profileSnapshot.route.executionTarget !== 'sandbox',
    )
  )
    throw new Error('saved-delegation-pilot-profile-refused');
  if (Object.keys(spec.recipes).length !== 2)
    throw new Error('saved-delegation-pilot-recipes-refused');
  const workerPins = ([left, right]: typeof spec.policy.workers) =>
    [left, right].map((role) => {
      const request = validateManagedRequest(spec.recipes[role.role]);
      const budget = request.effectiveGrant.budget;
      assertPrivateParentCommit(request, spec.policy.repositoryId, spec.source.commit, 'sandbox');
      profileSetRequestPolicy(profiles)(request);
      if (
        !isPrivateSubmission(request) ||
        request.executionSpecDigest !== role.recipeDigest ||
        request.route.providerAccountId !== role.accountId ||
        !('maxProviderRequests' in budget) ||
        budget.maxProviderRequests !== role.modelRequests ||
        budget.maxObservedTokens !== role.observedTokenStop ||
        budget.maxDurationSeconds !== role.wallSeconds
      )
        throw new Error('saved-delegation-pilot-recipes-refused');
      return {
        template: request,
        binding: {
          role: role.role,
          recipeId: role.recipeId,
          recipeRevision: role.recipeRevision,
          recipeDigest: role.recipeDigest,
          accountId: role.accountId,
          executionSpecDigest: request.executionSpecDigest,
        },
      };
    });
  const [left, right] = workerPins(spec.policy.workers);
  if (!left || !right) throw new Error('saved-delegation-pilot-recipes-refused');
  const { bundlePath, ...source } = spec.source;
  const bundle = await readPrivatePilotFile(bundlePath, MAX_CANDIDATE_BYTES);
  if (sha256(bundle) !== source.bundleDigest)
    throw new Error('saved-delegation-pilot-seed-mismatch');
  await withVerifiedCheckpointMirror(scratch, source, bundle, async () => {});
  const runtimeDigest = digest([
    'saved-delegation-pilot-runtime/v1',
    spec.owner,
    spec.policyId,
    spec.policy,
    spec.repositoryDigest,
    source,
    profiles,
    left.binding,
    right.binding,
    spec.sandbox,
    spec.endpoints,
    spec.authorities,
  ]);
  return {
    principal: { ...spec.owner, operatorPrincipal: 'delegated-user' as const },
    spec,
    profiles,
    left,
    right,
    source,
    bundle,
    runtimeDigest,
  };
}

type ManagedDeps = Parameters<typeof composeManagedProfileSet>[2];
/** Concrete hosted backend for a single repository. Must be connected to the
 * daemon's parent checkout, scoped bridge and startup registry before advertise(). */
export async function composeSavedDelegationPilot(input: {
  file: string;
  rawAzureTarget: string;
  ordinarySandboxScope?: string;
  credentialsDirectory: string | undefined;
  db: Database.Database;
  databasePath: string;
  logger: Logger;
  issuer: PodTokenIssuer;
  cli: NonNullable<Parameters<typeof composeManagedProfileSet>[1]>;
  providerAccounts: ManagedDeps['providerAccounts'];
  githubAuth: ManagedDeps['githubAuth'];
  wakeupJournal?: Parameters<typeof composeOperatorSandboxTarget>[3]['wakeupJournal'];
  readBranchHead(repository: RepositoryConfig, branch: string): Promise<string>;
  observeParentSource: Parameters<typeof attachSavedDelegationRuntime>[0]['observeParentSource'];
  worktreeDirectory: string;
}) {
  const { db, issuer, logger } = input;
  const scratch = path.join(
    path.dirname(path.resolve(input.databasePath)),
    'managed',
    'saved-pilot',
  );
  const pilot = await readSavedDelegationPilot(input.file, scratch);
  const { principal, spec, profiles, runtimeDigest, source, bundle, left, right } = pilot;
  const cli = input.cli.bindings.filter(
    (entry) =>
      entry.installationId === profiles.installationId &&
      entry.objectId === principal.oid &&
      entry.issuer === principal.iss &&
      entry.audience === principal.aud,
  );
  if (cli.length !== 1) throw new Error('saved-delegation-pilot-owner-refused');
  for (const stage of profiles.profiles)
    chatGptCredential(input.providerAccounts, stage.profileSnapshot.route.providerAccountId);
  const sandbox = composeOperatorSandboxTarget(input.rawAzureTarget, spec.sandbox, logger, {
    managedDatabase: db,
    wakeupJournal: input.wakeupJournal,
  });
  if (!sandbox || sandbox.executionResourceScope === input.ordinarySandboxScope)
    throw new Error('saved-delegation-pilot-target-refused');
  const transport = await loadParentEvaluatorTlsFetch(spec.endpoints, input.credentialsDirectory);
  const dispatchKeys = await readEvaluatorDispatchKeys(input.credentialsDirectory);
  // Check the dispatch keys at boot, but derive the signer from each run's exact combined policy.
  createEvaluatorDispatchSigner(dispatchKeys, {
    ...spec.authorities,
    basePolicyDigest: digest(spec.policy),
  });
  const policies = createSavedDelegationPolicyStore(db);
  let advertised = false;
  const launchHost: SavedDelegationLaunchHost = {
    scratch,
    available: () => advertised,
    async readVerifiedPins(policy, config: Readonly<EffectiveLaunchConfig>) {
      const repository = config.repository;
      if (
        !repository ||
        repository.config.provider !== 'github' ||
        configurationDigest(repository.config) !== spec.repositoryDigest ||
        canonical(policy) !== canonical(spec.policy)
      )
        configurationError(
          'The Task is outside the single-repo delegation pilot',
          'DELEGATION_PILOT_SCOPE_REFUSED',
          409,
        );
      // Authenticate the configured repository and check the explicit branch before freezing the staged seed.
      if ((await input.readBranchHead(repository.config, policy.sourceBranch)) !== source.commit)
        configurationError(
          'The pilot branch moved. Refresh and review its pinned source before launch.',
          'DELEGATION_PILOT_SOURCE_CHANGED',
          409,
        );
      const budgetExpiry = Math.min(
        ...[left, right].map((entry) => entry.template.effectiveGrant.budget.expiresAt),
      );
      if (budgetExpiry <= Math.floor(Date.now() / 1000) + 300)
        configurationError(
          'The staged worker recipes expire too soon for a new pilot Task',
          'DELEGATION_PILOT_RECIPE_EXPIRED',
          409,
        );
      return {
        source: {
          ...source,
          repositoryDigest: spec.repositoryDigest,
          ref: 'refs/heads/' + policy.sourceBranch,
        },
        workers: [left.binding, right.binding],
        authorities: spec.authorities,
        checksDigest: policy.checksDigest,
        reviewPolicyDigest: policy.reviewer.policyDigest,
        runtimeDigest,
      };
    },
    async readSeedBundle(plan) {
      if (
        plan.policyId !== spec.policyId ||
        plan.pins.runtimeDigest !== runtimeDigest ||
        plan.pins.source.bundleDigest !== source.bundleDigest
      )
        throw new Error('saved-delegation-pilot-plan-refused');
      const policy = savedDelegationGatePolicy(plan);
      const signer = createEvaluatorDispatchSigner(dispatchKeys, policy);
      const binding = {
        run: plan.runId,
        repository: spec.policy.repositoryId,
        predecessor: source.commit,
        paths: spec.policy.workers.flatMap((role) => role.files).sort(),
      };
      try {
        if (spec.evaluatorEnrollment === 'automatic')
          await enrollParentEvaluators(
            spec.endpoints,
            transport,
            signer,
            {
              ...binding,
              basePolicyDigest: policy.basePolicyDigest,
              ...(source.resultTransport ? { resultTransport: source.resultTransport } : {}),
            },
            policy,
          );
        else
          await requireEvaluatorReadiness(spec.endpoints, transport, signer, {
            ...binding,
            policyDigest: combinedPolicyDigest(policy),
          });
      } catch {
        configurationError(
          'The independent evaluators did not accept this exact reviewed Task. Nothing was launched.',
          'DELEGATION_PILOT_EVALUATORS_NOT_READY',
          409,
        );
      }
      return Buffer.from(bundle);
    },
  };
  return {
    launchHost,
    principal,
    /** Call only after the provision, ingress and recovery hooks have been installed. */
    advertise() {
      policies.installPilot(principal, spec.policyId, spec.policy);
      advertised = true;
    },
    stopAdvertising() {
      advertised = false;
    },
    async attach(podId: string) {
      const { plan, checkpoint } = readSavedDelegationAdmission(db, podId, principal);
      if (plan.policyId !== spec.policyId || plan.pins.runtimeDigest !== runtimeDigest)
        throw new Error('saved-delegation-pilot-run-mismatch');
      const managed = composeManagedProfileSet(
        profiles,
        { ...input.cli, bindings: cli },
        {
          db,
          databasePath: input.databasePath,
          manager: sandbox,
          sandboxCoding: spec.sandbox,
          sandboxCheckpoints: true,
          providerAccounts: input.providerAccounts,
          githubAuth: input.githubAuth,
          ownsInstallation: (installation) => installation === 'native.' + plan.runId,
        },
      );
      const gatePolicy = savedDelegationGatePolicy(plan);
      const gates = createParentEvaluatorClient(
        spec.endpoints,
        gatePolicy,
        transport,
        createEvaluatorDispatchSigner(dispatchKeys, gatePolicy),
      );
      let runtime: ReturnType<typeof attachSavedDelegationRuntime> | undefined;
      try {
        runtime = attachSavedDelegationRuntime({
          db,
          podId,
          principal,
          scratch,
          issuer,
          runtimeDigest,
          gates,
          recipes: { [left.binding.role]: left.template, [right.binding.role]: right.template },
          service: managed.components.service,
          collector: managed.privateRuntime,
          withWorkerSource: (mirror, _run, use) =>
            managed.withCheckpoint(
              {
                ...checkpoint,
                ...(plan.pins.source.resultTransport === 'anchored/v1'
                  ? { scopedTree: checkpoint.tree }
                  : {}),
              },
              mirror,
              () => use(),
            ),
          observeParentSource: input.observeParentSource,
        });
        await managed.resume();
      } catch (error) {
        if (runtime) await runtime.close();
        managed.close();
        throw error;
      }
      const close = runtime.close;
      return {
        ...runtime,
        materializeParent(generation: number) {
          return runtime!.withPinnedParentSource((mirror) =>
            materializeSavedPilotWorktree({
              root: input.worktreeDirectory,
              podId,
              generation,
              mirror,
              commit: checkpoint.commit,
              tree: checkpoint.tree,
              baseBranch: spec.policy.sourceBranch,
            }),
          );
        },
        async close() {
          await close();
          managed.close();
        },
      };
    },
  };
}

export async function materializeSavedPilotWorktree(input: {
  root: string;
  podId: string;
  generation: number;
  mirror: string;
  commit: string;
  tree: string;
  baseBranch: string;
}) {
  const { root, podId, generation, mirror, commit, tree, baseBranch } = input;
  if (
    !path.isAbsolute(root) ||
    path.normalize(root) !== root ||
    !path.isAbsolute(mirror) ||
    !/^[a-zA-Z0-9_-]{1,128}$/.test(podId) ||
    !Number.isSafeInteger(generation) ||
    generation < 1 ||
    !gitId.safeParse(commit).success ||
    !gitId.safeParse(tree).success ||
    !baseBranch
      .split('/')
      .every((name) => /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(name) && !name.endsWith('.')) ||
    baseBranch.includes('..') ||
    baseBranch.toLowerCase().endsWith('.lock')
  )
    throw new Error('saved-delegation-pilot-worktree-refused');
  const base = path.join(root, 'saved-delegation');
  await mkdir(base, { mode: 0o700, recursive: true });
  const directory = await lstat(base);
  if (
    !directory.isDirectory() ||
    directory.uid !== process.getuid?.() ||
    (directory.mode & 0o077) !== 0 ||
    (await realpath(base)) !== base
  )
    throw new Error('saved-delegation-pilot-worktree-root-refused');
  // Fresh exact generation only. Never erase or reuse an existing path, even if the
  // previous allocation failed; reconciliation owns retained resource cleanup.
  const allocation = path.join(base, `${podId}-${generation}`);
  await mkdir(allocation, { mode: 0o700 });
  const bareRepoPath = path.join(allocation, 'source.git');
  const worktreePath = path.join(allocation, 'workspace');
  await managedGit(allocation, ['init', '--bare', '-b', baseBranch, bareRepoPath]);
  await managedGit(bareRepoPath, [
    'fetch',
    '--no-tags',
    '--no-write-fetch-head',
    mirror,
    'refs/heads/main:refs/heads/' + baseBranch,
  ]);
  if ((await managedGit(bareRepoPath, ['rev-parse', 'refs/heads/' + baseBranch])) !== commit)
    throw new Error('saved-delegation-pilot-worktree-commit-mismatch');
  await managedGit(bareRepoPath, ['worktree', 'add', '--detach', worktreePath, commit]);
  const observed = await observeSavedPilotWorktree(worktreePath);
  if (observed.commit !== commit || observed.tree !== tree || !observed.clean)
    throw new Error('saved-delegation-pilot-worktree-content-mismatch');
  return { worktreePath, bareRepoPath, startCommitSha: commit };
}

/** Observe a real parent checkout before issuing any delegate attempt token. */
export async function observeSavedPilotWorktree(worktree: string) {
  return {
    commit: await managedGit(worktree, ['rev-parse', 'HEAD']),
    tree: await managedGit(worktree, ['rev-parse', 'HEAD^{tree}']),
    clean: (await managedGit(worktree, ['status', '--porcelain', '--untracked-files=all'])) === '',
  };
}
