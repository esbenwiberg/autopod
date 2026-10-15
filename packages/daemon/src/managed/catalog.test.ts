import { readFileSync } from 'node:fs';
import { afterEach, expect, it, vi } from 'vitest';
import type { ConfigurationStore } from '../configuration/configuration-store.js';
import type { WorktreeCreateConfig } from '../interfaces/worktree-manager.js';
import { requestTimeFixture, resign } from '../test-utils/managed-fixture.js';
import { MemoryArtifactStore } from './artifact-store.js';
import { digest } from './canonical.js';
import { composeManagedCatalog } from './catalog.js';
import { admitManagedRequest, validateManagedRequest } from './grants.js';
import type { ManagedProfileSetConfig, composeManagedProfileSet } from './profile-set-config.js';

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});
function fixture() {
  const f = requestTimeFixture();
  cleanups.push(() => f.close());
  f.db.exec(
    readFileSync(
      new URL('../db/migrations/208_managed_catalog_preparations.sql', import.meta.url),
      'utf8',
    ),
  );
  const config = {
    mode: 'reviewed-profile-set-v1',
    installationId: 'installation-one',
    profiles: [
      {
        profileSnapshot: f.request.profileSnapshot,
        taskKind: 'research',
        artifactPath: 'research.md',
        sourceMode: 'none',
        inputNames: [],
      },
    ],
    mirror: {
      enrollmentId: 'canary',
      path: '/canary',
      remote: 'origin',
      baseRevision: 'a'.repeat(40),
    },
    image: `registry.example/worker@sha256:${'a'.repeat(64)}`,
  } as ManagedProfileSetConfig;
  const service = f.service();
  const legacy = {
    config: { db: f.db, store: new MemoryArtifactStore() },
    components: { service, runtime: f.runtime },
    bindings: [],
    close: vi.fn(),
  } as unknown as ReturnType<typeof composeManagedProfileSet>;
  const repositories = ['repo-one', 'repo-two'].map((id) => ({
    id,
    name: id,
    archived: false,
    payload: {
      remote: `https://github.com/example/${id}`,
      defaultSetupId: 'main',
      setups: [{ id: 'main', defaultBranch: 'main' }],
    },
  }));
  const create = vi.fn(async (_input: WorktreeCreateConfig) => ({
    worktreePath: '/scratch/one',
    bareRepoPath: '/mirrors/shared.git',
    startCommitSha: 'b'.repeat(40),
  }));
  const cleanup = vi.fn(async () => {});
  const dependencies = {
    db: f.db,
    databasePath: '/tmp/test/catalog.db',
    manager: {},
    catalog: {
      list: () => repositories,
      get: (_kind: string, id: string) => repositories.find((entry) => entry.id === id),
    } as unknown as ConfigurationStore,
    worktrees: { create, cleanup },
    providerAccounts: {},
    githubAuth: {},
  } as unknown as Parameters<typeof composeManagedCatalog>[2];
  const catalog = composeManagedCatalog(config, legacy, dependencies);
  const descriptor = {
    jobId: 'job-one',
    attemptId: 'attempt-one',
    startKey: 'start-one',
    kind: 'research',
    objective: 'Inspect the second repository and report evidence.',
    artifactPath: 'research.md',
    repositories: [{ repositoryId: 'repo-two', access: 'read' }],
  };
  return { f, catalog, descriptor, create, cleanup, dependencies, config, legacy };
}

it('prepares a non-canary catalog repository at an exact commit without starting a worker', async () => {
  const { f, catalog, descriptor, create, cleanup } = fixture();
  const request = await catalog.components.service.catalog!.prepare('installation-one', descriptor);
  validateManagedRequest(request);
  expect(request.profileSnapshot.scope.repositories).toEqual([
    {
      enrollmentId: 'repo-two',
      remote: 'repo-two',
      baseRevision: 'b'.repeat(40),
      branchNamespace: 'dispatcher/',
      access: 'read',
    },
  ]);
  expect(request.route).toEqual(f.request.route);
  expect(request.outputs.source).toMatchObject({ mode: 'none' });
  expect(create.mock.calls[0]?.[0]).toMatchObject({
    repoUrl: 'https://github.com/example/repo-two',
    startBranch: 'main',
  });
  expect(cleanup).toHaveBeenCalledWith('/scratch/one');
  expect(JSON.parse(request.task.contextFiles![0]!.content)[0].remote).toBe(
    'https://github.com/example/repo-two',
  );
  expect(f.launches()).toBe(0);
  admitManagedRequest(request, catalog.components.service.admission, Math.floor(Date.now() / 1000));
});

it('replays a preparation after reconstruction without resolving a moving branch again', async () => {
  const { catalog, descriptor, create, dependencies, config, legacy } = fixture();
  const first = await catalog.components.service.catalog!.prepare('installation-one', descriptor);
  const restarted = composeManagedCatalog(config, legacy, dependencies);
  expect(
    await restarted.components.service.catalog!.prepare('installation-one', descriptor),
  ).toEqual(first);
  expect(create).toHaveBeenCalledTimes(1);
  await expect(
    restarted.components.service.catalog!.prepare('installation-one', {
      ...descriptor,
      repositories: [{ repositoryId: 'repo-one', access: 'read' }],
    }),
  ).rejects.toThrow('managed-catalog-preparation-conflict');
});

it('refuses arbitrary repositories, writes, foreign installation and client grants before worker effects', async () => {
  const { f, catalog, descriptor, create } = fixture();
  const prepare = catalog.components.service.catalog!.prepare;
  await expect(prepare('other-installation', descriptor)).rejects.toThrow(
    'managed-catalog-installation',
  );
  for (const repositories of [
    [{ repositoryId: 'https://github.com/foreign/repo', access: 'read' }],
    [{ repositoryId: 'repo-two', access: 'write' }],
  ])
    await expect(prepare('installation-one', { ...descriptor, repositories })).rejects.toThrow();
  await expect(
    prepare('installation-one', { ...descriptor, effectiveGrant: f.request.effectiveGrant }),
  ).rejects.toThrow();
  expect(create).not.toHaveBeenCalled();
  expect(f.launches()).toBe(0);
});

it('binds contextual report bytes and rejects corruption even when the outer request is resigned', async () => {
  const { catalog, descriptor } = fixture();
  const request = await catalog.components.service.catalog!.prepare('installation-one', descriptor);
  request.task.contextFiles = [
    {
      path: 'dispatcher-inputs/job-parent/research.md',
      content: 'observed research',
      sha256: 'sha256:37f5ea43b4955884f99ce2f7f2a6dd0f9832b4dfbebc323f86518a4a3ea50b64',
      sourceJobId: 'job-parent',
      evidenceLevel: 'artifact-contract-verified',
    },
  ];
  request.task.contextBundleDigest = digest(request.task.contextFiles);
  resign(request);
  expect(() => validateManagedRequest(request)).toThrow('managed-context-binding-mismatch');
});

it('permits repository-free reports using the same reviewed artifact route', async () => {
  const { catalog, descriptor, create } = fixture();
  const request = await catalog.components.service.catalog!.prepare('installation-one', {
    ...descriptor,
    repositories: [],
    kind: 'report',
    artifactPath: 'report.html',
  });
  expect(request.effectiveGrant.scope.repositories).toEqual([]);
  expect(create).not.toHaveBeenCalled();
  validateManagedRequest(request);
});
