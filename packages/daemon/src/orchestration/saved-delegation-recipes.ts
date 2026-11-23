import type { ManagedPodRequest } from '@autopod/shared';
import { digest } from '../managed/canonical.js';
import { validateManagedRequest } from '../managed/grants.js';
import {
  assertPrivateParentCommit,
  PRIVATE_PARENT_VERIFIER,
  PRIVATE_SUBMISSION_FILE,
  PRIVATE_SUBMISSION_MAX_BYTES,
} from '../managed/private-commit-policy.js';
import {
  type ManagedProfileSetConfig,
  type ManagedProfileStage,
  profileSetRequestPolicy,
} from '../managed/profile-set-config.js';
import type { SavedDelegationPolicy } from './saved-delegation-policy.js';

type Role = SavedDelegationPolicy['workers'][number];
/** The policy pins the reviewed stage, not a hand-built task or current branch. */
export function savedWorkerRecipeDigest(stage: Readonly<ManagedProfileStage>) {
  return digest(['saved-worker-recipe/v1', stage]);
}

export function bindSavedWorkerRecipes(
  config: ManagedProfileSetConfig,
  policy: Readonly<SavedDelegationPolicy>,
  commit: string,
) {
  const select = (role: Role) => {
    const approved = config.profiles.find(
      (stage) => stage.profileSnapshot.profileId === role.recipeId,
    );
    if (
      !approved ||
      approved.profileSnapshot.profileVersion !== role.recipeRevision ||
      savedWorkerRecipeDigest(approved) !== role.recipeDigest ||
      approved.profileSnapshot.route.providerAccountId !== role.accountId
    )
      throw new Error('saved-delegation-profile-revision-refused');
    const { snapshotDigest: _, ...profile } = structuredClone(approved.profileSnapshot);
    const repository = profile.scope.repositories[0];
    const budget = profile.budget;
    if (
      !repository ||
      !('maxProviderRequests' in budget) ||
      budget.maxProviderRequests !== role.modelRequests ||
      budget.maxObservedTokens !== role.observedTokenStop ||
      budget.maxDurationSeconds !== role.wallSeconds
    )
      throw new Error('saved-delegation-profile-budget-refused');
    repository.baseRevision = commit;
    const profileSnapshot = { ...profile, snapshotDigest: digest(profile) };
    const key = 'saved-recipe-' + role.role;
    const grant: Omit<ManagedPodRequest['effectiveGrant'], 'digest'> = {
      schemaVersion: 1,
      grantId: key,
      revision: role.recipeRevision,
      dispatcherAttemptId: key,
      profileSnapshotDigest: profileSnapshot.snapshotDigest,
      route: profile.route,
      scope: profile.scope,
      budget,
    };
    const path = PRIVATE_SUBMISSION_FILE;
    const body: Omit<ManagedPodRequest, 'executionSpecDigest'> = {
      schemaVersion: 1,
      managedMode: true,
      dispatcherJobId: key,
      dispatcherAttemptId: key,
      startKey: key,
      profileSnapshot,
      effectiveGrant: { ...grant, digest: digest(grant) },
      route: profile.route,
      task: {
        kind: 'implementation',
        objective: 'Implement only the assigned text change and return the private submission.',
        contextBundleDigest: digest([]),
      },
      outputs: {
        source: {
          mode: 'commit',
          repository: policy.repositoryId,
          remote: 'private',
          base: policy.sourceBranch,
          head: repository.branchNamespace + key,
        },
        artifacts: {
          mode: 'required',
          root: '/output',
          include: [path],
          requiredPaths: [path],
          exclude: [],
          limits: {
            maxFiles: 1,
            maxFileBytes: PRIVATE_SUBMISSION_MAX_BYTES,
            maxTotalBytes: PRIVATE_SUBMISSION_MAX_BYTES,
          },
          links: { allowSymlinks: false, allowHardlinks: false },
        },
      },
      inputArtifacts: [],
      validation: { suite: 'private-submission', verifierPolicy: PRIVATE_PARENT_VERIFIER },
    };
    const template = validateManagedRequest({ ...body, executionSpecDigest: digest(body) });
    assertPrivateParentCommit(template, policy.repositoryId, commit, 'sandbox');
    return {
      stage: { ...approved, profileSnapshot },
      template,
      binding: {
        role: role.role,
        recipeId: role.recipeId,
        recipeRevision: role.recipeRevision,
        recipeDigest: role.recipeDigest,
        accountId: role.accountId,
        executionSpecDigest: template.executionSpecDigest,
      },
    };
  };
  const [left, right] = policy.workers.map(select);
  if (!left || !right) throw new Error('saved-delegation-role-required');
  const profiles = {
    ...config,
    mirror: { ...config.mirror, baseRevision: commit },
    profiles: [
      ...new Map(
        [left.stage, right.stage].map((stage) => [stage.profileSnapshot.profileId, stage]),
      ).values(),
    ],
  };
  for (const entry of [left, right]) profileSetRequestPolicy(profiles)(entry.template);
  return { profiles, left, right };
}
