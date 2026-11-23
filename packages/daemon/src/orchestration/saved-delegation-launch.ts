import { type EffectiveLaunchConfig, launchRequestSchema } from '@autopod/shared';
import { z } from 'zod';
import { configurationError } from '../configuration/configuration-store.js';
import {
  configurationDigest,
  type LaunchResolutionServices,
  resolveLaunch,
} from '../configuration/launch-resolver.js';
import { canonical, digest } from '../managed/canonical.js';
import { gatePinsSchema, gatePolicySchema } from './combined-attestation.js';
import {
  type DelegationPrincipal,
  delegationOwnerDigest,
  delegationPin,
  type SavedDelegationPolicy,
  type SavedDelegationPolicyStore,
} from './saved-delegation-policy.js';

const oid = z.string().regex(/^[a-f0-9]{40}$/);
const recipeBinding = z
  .object({
    role: z.string().min(1).max(64),
    recipeId: z.string().min(1).max(64),
    recipeRevision: z.number().int().positive(),
    recipeDigest: delegationPin,
    accountId: z.string().min(1).max(160),
    executionSpecDigest: delegationPin,
  })
  .strict();
const verifiedPinsSchema = z
  .object({
    source: z
      .object({
        repositoryDigest: z.string().regex(/^[a-f0-9]{64}$/),
        ref: z.string().min(1).max(172),
        predecessor: oid,
        commit: oid,
        tree: oid,
        bundleDigest: delegationPin,
      })
      .strict(),
    workers: z.tuple([recipeBinding, recipeBinding]),
    authorities: gatePinsSchema,
    checksDigest: delegationPin,
    reviewPolicyDigest: delegationPin,
    // Exact sandbox/image/runtime boundary, resolved by the privileged host, not a caller.
    runtimeDigest: delegationPin,
  })
  .strict();

type VerifiedPins = z.infer<typeof verifiedPinsSchema>;
export const savedDelegationRunId = (owner: string, requestId: string) =>
  digest(['saved-delegation-run/v1', owner, requestId]).slice(7);

function assertParent(config: EffectiveLaunchConfig, policy: SavedDelegationPolicy) {
  const reviewer = config.ai.reviewer;
  const repository = config.repository;
  const repoRevision = config.revisions.find(
    (r) => r.kind === 'repository' && r.id === policy.repositoryId,
  );
  if (
    !repository ||
    repository.id !== policy.repositoryId ||
    repoRevision?.revision !== policy.repositoryRevision
  )
    configurationError(
      'Repository configuration changed or is outside this policy',
      'DELEGATION_REPOSITORY_MISMATCH',
      409,
    );
  const base = config.work.baseBranch ?? repository.setup.defaultBranch;
  const start = config.work.startBranch ?? base;
  if (
    base !== policy.sourceBranch ||
    start !== policy.sourceBranch ||
    config.execution.target !== 'local' ||
    !config.execution.networkPolicy?.enabled ||
    !['deny-all', 'restricted'].includes(config.execution.networkPolicy.mode ?? '') ||
    config.workflow.completion !== 'approval' ||
    config.workflow.output !== 'none' ||
    config.pim.length ||
    config.references.length ||
    config.worker ||
    config.work.linkedPodId ||
    config.work.dependsOnPodIds?.length ||
    config.work.seriesId ||
    config.work.intentionalRerun ||
    config.work.analysis ||
    config.githubAccess.some(
      (access) =>
        access.rule.operations.some((op) => !op.endsWith('.read')) ||
        access.repositoryIds.some((repoId) => repoId !== repository.config.providerRepositoryId),
    ) ||
    repository.setup.integrations.deployment?.enabled ||
    repository.setup.integrations.serviceAccess.length
  )
    configurationError(
      'Task permissions or source are incompatible with this delegation policy',
      'DELEGATION_TASK_REFUSED',
      409,
    );
  if (
    config.ai.main.providerAccountId === policy.reviewer.accountId ||
    config.ai.main.failover.length ||
    config.ai.main.maxHops ||
    reviewer.mode !== 'independent' ||
    reviewer.route.providerAccountId !== policy.reviewer.accountId ||
    reviewer.route.failover.length ||
    reviewer.route.maxHops ||
    config.workflow.reviewerTokenBudget !== policy.reviewer.tokenBudget
  )
    configurationError(
      'Task must use the independent reviewer and budget saved in the policy',
      'DELEGATION_REVIEWER_MISMATCH',
      409,
    );
}

/**
 * Daemon-only, read-only launch contract. The trusted host must independently
 * resolve source, recipes and evaluator capability. No request value satisfies
 * that port, and this module cannot insert a pod, stage credentials, or dispatch.
 */
export async function prepareSavedDelegationLaunch(input: {
  request: unknown;
  principal: DelegationPrincipal;
  policies: SavedDelegationPolicyStore;
  launch: LaunchResolutionServices;
  readVerifiedPins: (
    policy: Readonly<SavedDelegationPolicy>,
    config: Readonly<EffectiveLaunchConfig>,
  ) => Promise<VerifiedPins>;
}) {
  const { delegation, expectedDigest, ...ordinary } = launchRequestSchema.parse(input.request);
  if (!delegation || !ordinary.requestId || !('repositoryId' in ordinary))
    configurationError(
      'Select a saved delegation policy for a new repository Task',
      'DELEGATION_SELECTION_REQUIRED',
      400,
    );
  const principal = { ...input.principal };
  const owner = delegationOwnerDigest(principal);
  const saved = input.policies.readCurrent(principal, delegation.policyId, delegation.revision);
  if (ordinary.repositoryId !== saved.policy.repositoryId)
    configurationError('Repository is outside this policy', 'DELEGATION_REPOSITORY_MISMATCH', 409);

  // This is a private preview composition, not a fallback launch request.
  const config = await resolveLaunch(ordinary, input.launch, principal.oid);
  assertParent(config, saved.policy);
  const pins = verifiedPinsSchema.parse(
    await input.readVerifiedPins(structuredClone(saved.policy), structuredClone(config)),
  );
  const workers = saved.policy.workers.map(
    ({ role, recipeId, recipeRevision, recipeDigest, accountId }) => ({
      role,
      recipeId,
      recipeRevision,
      recipeDigest,
      accountId,
    }),
  );
  if (
    pins.source.repositoryDigest !== configurationDigest(config.repository?.config) ||
    pins.source.ref !== 'refs/heads/' + saved.policy.sourceBranch ||
    canonical(pins.workers.map(({ executionSpecDigest: _, ...binding }) => binding)) !==
      canonical(workers) ||
    pins.authorities.checks.configurationDigest !== saved.policy.checksDigest ||
    pins.authorities.independentReview.configurationDigest !== saved.policy.reviewer.policyDigest ||
    !gatePolicySchema.safeParse({ ...pins.authorities, basePolicyDigest: saved.policyDigest })
      .success ||
    pins.checksDigest !== saved.policy.checksDigest ||
    pins.reviewPolicyDigest !== saved.policy.reviewer.policyDigest
  )
    configurationError(
      'Trusted source or recipe pins do not match the saved policy',
      'DELEGATION_PINS_MISMATCH',
      409,
    );

  // Different owner/UUID pairs never share a worker ledger. The same pair must
  // be checked against its frozen binding, not minted a second budget on retry.
  const runId = savedDelegationRunId(owner, ordinary.requestId);
  const body = {
    version: 1 as const,
    runId,
    requestId: ordinary.requestId,
    launchDigest: config.digest,
    ...saved,
    pins,
    workerModelRequests: saved.policy.workers.reduce(
      (total, worker) => total + worker.modelRequests,
      0,
    ),
  };
  const digestAtPreview = configurationDigest(body);
  const plan = { ...body, digest: digestAtPreview };
  if (expectedDigest && expectedDigest !== digestAtPreview)
    configurationError(
      'Delegation launch changed; review the new plan',
      'DELEGATION_PREVIEW_CHANGED',
      409,
    );
  const assertCurrent = () => {
    const { digest: planDigest, ...planBody } = plan;
    const { digest: launchDigest, ...launchBody } = config;
    if (
      planDigest !== digestAtPreview ||
      configurationDigest(planBody) !== digestAtPreview ||
      launchDigest !== body.launchDigest ||
      configurationDigest(launchBody) !== body.launchDigest
    )
      configurationError(
        'Delegation plan changed after preparation',
        'DELEGATION_PREVIEW_CHANGED',
        409,
      );
    const current = input.policies.readCurrent(principal, saved.policyId, saved.revision);
    if (current.policyDigest !== saved.policyDigest)
      configurationError(
        'Delegation policy changed; review the new plan',
        'DELEGATION_POLICY_CHANGED',
        409,
      );
    input.launch.store.assertCurrent(config.revisions);
  };
  assertCurrent();
  return { plan, config, assertCurrent };
}
