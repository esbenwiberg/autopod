import { chmod, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, it } from 'vitest';
import { digest, sha256 } from '../managed/canonical.js';
import {
  PRIVATE_COMMIT_EFFECTS,
  PRIVATE_PARENT_VERIFIER,
  PRIVATE_SUBMISSION_FILE,
} from '../managed/private-commit-policy.js';
import { managedGit } from '../managed/source-git.js';
import { fixtureSigner } from '../test-utils/gate-signer.js';
import { resign } from '../test-utils/managed-fixture.js';
import { createTestDb } from '../test-utils/mock-helpers.js';
import { setupOrchestrationRun } from '../test-utils/orchestration-run-fixture.js';
import { withVerifiedCheckpointMirror } from './local-checkpoints.js';
import {
  materializeSavedPilotWorktree,
  observeSavedPilotWorktree,
  readSavedDelegationPilot,
} from './saved-delegation-pilot.js';
import { createSavedDelegationPolicyStore } from './saved-delegation-policy.js';

async function fixture() {
  const seed = await setupOrchestrationRun();
  const { root, cp, bytes } = seed;
  const specPath = path.join(root, 'pilot.json');
  const bundlePath = path.join(root, 'seed.bundle');
  const request = structuredClone(seed.request);
  request.task.kind = 'implementation';
  request.validation.verifierPolicy = PRIVATE_PARENT_VERIFIER;
  const profile = request.profileSnapshot;
  for (const route of [profile.route, request.route, request.effectiveGrant.route])
    route.executionTarget = 'sandbox';
  profile.scope = {
    ...profile.scope,
    allowedEffects: [...PRIVATE_COMMIT_EFFECTS],
    identityBindings: [],
    network: { ...profile.scope.network, destinations: [] },
    repositories: [
      {
        enrollmentId: cp.repository,
        access: 'write',
        baseRevision: cp.commit,
        remote: 'private',
        branchNamespace: 'autopod/',
      },
    ],
  };
  request.effectiveGrant.scope = structuredClone(profile.scope);
  const { snapshotDigest: _, ...profileBody } = profile;
  profile.snapshotDigest = request.effectiveGrant.profileSnapshotDigest = digest(profileBody);
  request.outputs.source = {
    mode: 'commit',
    repository: cp.repository,
    remote: 'private',
    base: 'main',
    head: 'autopod/private',
  };
  request.outputs.artifacts.mode = 'required';
  request.outputs.artifacts.include = request.outputs.artifacts.requiredPaths = [
    PRIVATE_SUBMISSION_FILE,
  ];
  request.outputs.artifacts.limits = { maxFiles: 1, maxFileBytes: 16384, maxTotalBytes: 16384 };
  resign(request);
  const budget = request.effectiveGrant.budget;
  if (!('maxProviderRequests' in budget)) throw new Error('fixture budget');
  const role = (name: string, file: string) => ({
    role: name,
    recipeId: 'implement',
    recipeRevision: 1,
    recipeDigest: request.executionSpecDigest,
    accountId: request.route.providerAccountId,
    files: [file],
    modelRequests: budget.maxProviderRequests,
    observedTokenStop: budget.maxObservedTokens,
    wallSeconds: budget.maxDurationSeconds,
  });
  const checks = fixtureSigner('checks', 'fixture-checks', digest('checks')).authority;
  const review = fixtureSigner('independentReview', 'fixture-review', digest('review')).authority;
  const spec = {
    version: 1,
    owner: {
      oid: '170c8187-229c-43b3-a8c9-a45f305b77d6',
      iss: 'https://issuer.example.invalid/',
      aud: 'api://fixture',
    },
    policyId: '1ddd388a-1c79-4a99-acfc-6a4817a9a4d8',
    policy: {
      version: 1,
      name: 'One repo pilot',
      repositoryId: cp.repository,
      repositoryRevision: 1,
      sourceBranch: 'main',
      workers: [role('left', 'proof.txt'), role('right', 'other.txt')],
      maxConcurrentWorkers: 2,
      checksDigest: checks.configurationDigest,
      reviewer: {
        accountId: 'review',
        tokenBudget: 8000,
        policyDigest: review.configurationDigest,
      },
    },
    repositoryDigest: 'a'.repeat(64),
    source: {
      predecessor: cp.predecessor,
      commit: cp.commit,
      tree: cp.tree,
      bundleDigest: sha256(bytes),
      bundlePath,
    },
    sandbox: { resourceScopeDigest: digest('isolated'), readyDiskImageId: 'fixture-disk' },
    profiles: {
      mode: 'reviewed-profile-set-v1',
      installationId: 'fixture-installation',
      profiles: [
        {
          profileSnapshot: profile,
          taskKind: 'implementation',
          artifactPath: PRIVATE_SUBMISSION_FILE,
          inputNames: [],
          privateCommit: true,
          sourceMode: 'commit',
        },
      ],
      mirror: {
        enrollmentId: cp.repository,
        path: path.join(root, 'reserved-mirror.git'),
        remote: 'private',
        baseRevision: cp.commit,
      },
      image: 'registry.example.invalid/worker@sha256:' + 'b'.repeat(64),
    },
    recipes: { left: request, right: request },
    endpoints: {
      checks: 'https://checks.example.invalid/verify',
      independentReview: 'https://review.example.invalid/verify',
    },
    authorities: { checks, independentReview: review },
  };
  const write = (value: unknown = spec) =>
    writeFile(specPath, JSON.stringify(value), { mode: 0o600 });
  await writeFile(bundlePath, bytes, { flag: 'wx', mode: 0o600 });
  await write();
  return {
    ...seed,
    spec,
    specPath,
    bundlePath,
    write,
    read: () => readSavedDelegationPilot(specPath, path.join(root, 'scratch')),
  };
}

it('loads exact private pilot material and installs its policy idempotently, without overwriting a revision', async () => {
  const f = await fixture();
  const pilot = await f.read();
  expect(pilot.source.commit).toBe(f.cp.commit);
  expect(pilot.bundle).toEqual(f.bytes);
  expect(pilot.left.binding.executionSpecDigest).toBe(f.spec.recipes.left.executionSpecDigest);
  expect((await f.read()).runtimeDigest).toBe(pilot.runtimeDigest);
  const db = createTestDb();
  try {
    const store = createSavedDelegationPolicyStore(db);
    const added = store.installPilot(pilot.principal, f.spec.policyId, f.spec.policy);
    expect(store.installPilot(pilot.principal, f.spec.policyId, f.spec.policy)).toEqual(added);
    expect(store.listCurrent(pilot.principal, f.cp.repository)).toHaveLength(1);
    expect(() =>
      store.installPilot(pilot.principal, f.spec.policyId, { ...f.spec.policy, name: 'Changed' }),
    ).toThrow('saved-delegation-pilot-policy-changed');
  } finally {
    db.close();
  }
});

it('refuses broad file permissions, symlink config, recipe drift and a different retained tree', async () => {
  const f = await fixture();
  await chmod(f.specPath, 0o644);
  await expect(f.read()).rejects.toThrow('saved-delegation-pilot-file-refused');
  await chmod(f.specPath, 0o600);
  const link = path.join(f.root, 'linked-pilot.json');
  await symlink(f.specPath, link);
  await expect(readSavedDelegationPilot(link, f.root)).rejects.toThrow();
  const right = resign({
    ...structuredClone(f.spec.recipes.right),
    task: { ...f.spec.recipes.right.task, objective: 'substituted template' },
  });
  await f.write({ ...f.spec, recipes: { ...f.spec.recipes, right } });
  await expect(f.read()).rejects.toThrow('saved-delegation-pilot-recipes-refused');
  await f.write({ ...f.spec, source: { ...f.spec.source, tree: 'f'.repeat(40) } });
  await expect(f.read()).rejects.toThrow('checkpoint-source-mismatch');
});

it('materializes a real detached parent at the admitted Git object with no origin or mutable branch input', async () => {
  const f = await fixture();
  const alloc = (mirror: string) =>
    materializeSavedPilotWorktree({
      root: f.root,
      podId: 'fixture-parent',
      generation: 1,
      mirror,
      commit: f.cp.commit,
      tree: f.cp.tree,
      baseBranch: 'main',
    });
  const workspace = await withVerifiedCheckpointMirror(f.root, f.cp, f.bytes, alloc);
  expect(await observeSavedPilotWorktree(workspace.worktreePath)).toEqual({
    commit: f.cp.commit,
    tree: f.cp.tree,
    clean: true,
  });
  expect(await managedGit(workspace.worktreePath, ['remote'])).toBe('');
  expect(await managedGit(workspace.bareRepoPath, ['rev-parse', 'refs/heads/main'])).toBe(
    f.cp.commit,
  );
  await writeFile(path.join(workspace.worktreePath, 'locally-edited'), 'keep this');
  expect((await observeSavedPilotWorktree(workspace.worktreePath)).clean).toBe(false);
  await expect(withVerifiedCheckpointMirror(f.root, f.cp, f.bytes, alloc)).rejects.toMatchObject({
    code: 'EEXIST',
  });
  expect((await observeSavedPilotWorktree(workspace.worktreePath)).clean).toBe(false);
});
