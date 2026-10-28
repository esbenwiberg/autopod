import path from 'node:path';
import type { OperatorActor } from '@autopod/shared';
import { vi } from 'vitest';
import {
  type SourceAdoptionControllerDependencies,
  createSourceAdoptionController,
} from '../pods/source-adoption-controller.js';
import {
  applyPinnedAdoption,
  inspectAdoptionGit,
  preparePinnedAdoption,
} from '../worktrees/source-adoption-git.js';
import { createSourceRevalidationHarness } from './adopted-source-validation-helpers.js';
import { createSourceWorkspaceFixture } from './source-container-helpers.js';

/** Real SQLite, filesystem, Git and local native-exec stand-in; validation engine/provider are mocked. */
export async function createSourceControllerFixture(options: { ignoredCollision?: boolean } = {}) {
  const base = await createSourceWorkspaceFixture(options);
  const { f, host, git, target, old, cm, root, podId } = base;
  const profile = {
    ...f.ctx.profileStore.get(f.pod().profileName),
    repoUrl: 'https://github.com/org/repo',
    validationSetupCommand: 'npm ci',
    skipValidationPhases: [],
  };
  f.podRepo.update(podId, {
    profileSnapshot: profile,
    validationAttempts: 3,
    options: { ...f.pod().options, validationSuite: 'full', validate: true },
  });
  const harness = createSourceRevalidationHarness(f, profile);
  const worktrees = {
    ...f.worktreeManager,
    inspectSourceAdoption: vi.fn(async () => {
      const state = await inspectAdoptionGit((args) => git(host, ...args), 'repair');
      return { branch: 'repair', commitSha: state.head, treeSha: state.tree, worktreeClean: true };
    }),
    observeSourceBranch: vi.fn(async () => target),
    prepareSourceAdoption: vi.fn<
      NonNullable<SourceAdoptionControllerDependencies['worktreeManager']['prepareSourceAdoption']>
    >((config) =>
      preparePinnedAdoption(
        config,
        (args) => git(host, ...args),
        async (ref) => {
          await git(host, 'update-ref', ref, target);
        },
      ),
    ),
    applySourceAdoption: vi.fn<
      NonNullable<SourceAdoptionControllerDependencies['worktreeManager']['applySourceAdoption']>
    >((config) => applyPinnedAdoption(config, (args) => git(host, ...args))),
  };
  const deps: SourceAdoptionControllerDependencies = {
    podRepo: f.podRepo,
    worktreeManager: worktrees,
    getContainerManager: () => cm,
    executionForPod: f.captured.resolveEffectiveBoundProfile,
    isNativeGoal: vi.fn(() => false),
    assertGuidanceCollected: f.guards.assertGuidanceCollected,
    assertIdle: vi.fn(() => {
      if (f.registry.activeAgentRuns.has(podId)) throw new Error('Original worker active');
    }),
    revalidate: (id, request) => harness.workflow().revalidateAdoptedSource(id, request),
    archiveRoot: path.join(root, 'controller-archives'),
    emit: vi.fn(),
  };
  const controller = createSourceAdoptionController(deps);
  const input = {
    id: 'source-controller',
    expectedGeneration: f.pod().lifecycleGeneration,
    oldHeadSha: old,
    targetHeadSha: target,
    dependencySetupCommand: 'npm ci',
    reason: 'Adopt exact human repaired source without delivery',
  };
  const actor: OperatorActor = { type: 'human', userId: 'fixture-owner' };
  const submit = () => controller.submit(podId, input, actor);
  return { ...base, profile, harness, worktrees, deps, controller, input, actor, submit };
}
