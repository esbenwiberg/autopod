import type {
  CreatePodRequest,
  EffectiveLaunchConfig,
  ExecutionRequirements,
  SpecContract,
} from '@autopod/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createWatcherBindingRepository } from '../issue-watcher/watcher-binding-repository.js';
import { createPodRepository } from '../pods/pod-repository.js';
import {
  createTestConfiguration,
  insertConfigurationTestPod,
} from '../test-utils/configuration-helpers.js';
import { createTestDb } from '../test-utils/mock-helpers.js';
import { createLaunchSnapshotRepository } from './launch-snapshot.js';
import { createWatcherLaunches } from './watcher-launches.js';

const databases: ReturnType<typeof createTestDb>[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});
function fixture() {
  const db = createTestDb();
  databases.push(db);
  const { store, services } = createTestConfiguration(db);
  const bindings = createWatcherBindingRepository(db);
  const binding = bindings.write(
    {
      id: 'watch',
      payload: {
        name: 'Repository issues',
        enabled: true,
        launch: { repositoryId: 'repo-a' },
        targets: { alternate: { repositoryId: 'repo-a', profileId: 'profile' } },
      },
    },
    'operator',
  );
  const pods = createPodRepository(db);
  const snapshots = createLaunchSnapshotRepository(db, store);
  let count = 0;
  const create = vi.fn((config: EffectiveLaunchConfig, owner: string) => {
    const id = `watch-pod-${++count}`;
    insertConfigurationTestPod(db, id);
    db.prepare('UPDATE pods SET user_id=?,task=?,branch=? WHERE id=?').run(
      owner,
      config.task,
      config.work.branch ?? `autopod/${id}`,
      id,
    );
    return pods.getOrThrow(id);
  });
  let ready = true;
  const launches = createWatcherLaunches({
    bindings,
    store,
    snapshots,
    pods,
    resolution: services,
    ready: () => ready,
    create,
  });
  const source = launches.list()[0];
  if (!source) throw new Error('Missing fixture source');
  const candidate = {
    id: '42',
    title: 'Issue',
    body: 'Untrusted issue body',
    url: 'https://github.com/org/repo-a/issues/42',
    labels: ['autopod'],
    triggerLabel: 'autopod',
  };
  const request: CreatePodRequest = {
    profileName: 'watch/autopod',
    task: 'Prepare the issue spec',
    branch: 'issue-42/plan',
    seriesId: 'issue-42',
  };
  return {
    db,
    store,
    services,
    bindings,
    binding,
    pods,
    snapshots,
    launches,
    source,
    candidate,
    request,
    create,
    setReady: (value: boolean) => {
      ready = value;
    },
  };
}
function generatedContract(executionRequirements: ExecutionRequirements): SpecContract {
  return {
    contractVersion: 1,
    title: 'Generated worker prerequisites',
    dependsOn: [],
    scenarios: [],
    requiredFacts: [],
    humanReview: [],
    executionRequirements,
  };
}

describe('watcher launch snapshots', () => {
  it.each([
    [
      {
        version: 2,
        executables: [],
        requiredReferenceRepositories: [
          { repositoryId: 'missing-input', commitSha: 'a'.repeat(40) },
        ],
      },
      false,
      'EXECUTION_REFERENCE_MISSING',
    ],
    [
      {
        version: 2,
        executables: [],
        requiredReferenceRepositories: [{ repositoryId: 'repo-b', commitSha: 'b'.repeat(40) }],
      },
      true,
      'EXECUTION_REFERENCE_MISMATCH',
    ],
    [
      { version: 2, executables: [], platform: 'linux/arm64' },
      false,
      'EXECUTION_PLATFORM_MISMATCH',
    ],
    [
      { version: 2, executables: [], platform: 'darwin/arm64' },
      false,
      'EXECUTION_PLATFORM_MISMATCH',
    ],
    [
      { version: 2, executables: ['docker'], requiresImageBuild: true },
      false,
      'EXECUTION_IMAGE_BUILD_UNSUPPORTED',
    ],
  ] satisfies Array<
    [ExecutionRequirements, boolean, string]
  >)('rejects generated worker prerequisites before final pod admission: %j', async (requirements, includeReference, code) => {
    const f = fixture();
    if (includeReference)
      f.bindings.write(
        {
          id: f.binding.id,
          expectedRevision: f.binding.revision,
          payload: {
            ...f.binding.payload,
            launch: {
              ...f.binding.payload.launch,
              referenceRepositories: [{ repositoryId: 'repo-b', ref: 'main', access: 'read' }],
            },
          },
        },
        'operator',
      );
    const planner = await f.launches.create(f.request, f.source, f.candidate);
    f.db.prepare("UPDATE pods SET status='complete' WHERE id=?").run(planner.id);
    const before = f.snapshots.get(planner.id);
    const admitted = f.db.prepare('SELECT * FROM pod_launch_snapshots').all();
    const pod = f.pods.getOrThrow(planner.id);
    await expect(
      f.launches.createWorker(
        {
          ...f.request,
          task: 'Implement generated brief',
          contract: generatedContract(requirements),
        },
        pod,
      ),
    ).rejects.toMatchObject({ code });
    // The real watcher derives/seals new work after planning; even its injected external
    // capability hook returning successfully must not bypass the final snapshot boundary.
    expect(f.services.assertCapabilities).toHaveBeenLastCalledWith(
      expect.objectContaining({
        work: expect.objectContaining({ contract: generatedContract(requirements) }),
        derivation: expect.objectContaining({ kind: 'watcher-worker' }),
      }),
    );
    expect(f.create).toHaveBeenCalledOnce(); // Planner only, never a worker.
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM pods').get()).toEqual({ n: 1 });
    expect(f.db.prepare('SELECT * FROM pod_launch_snapshots').all()).toEqual(admitted);
    expect(f.snapshots.get(planner.id)).toEqual(before);
    expect(f.pods.getOrThrow(planner.id)).toEqual(pod);
  });

  it('admits matching generated v2 work and replays its receipt before discovery or capability checks', async () => {
    const f = fixture();
    f.bindings.write(
      {
        id: f.binding.id,
        expectedRevision: f.binding.revision,
        payload: {
          ...f.binding.payload,
          launch: {
            ...f.binding.payload.launch,
            referenceRepositories: [{ repositoryId: 'repo-b', ref: 'main', access: 'read' }],
          },
        },
      },
      'operator',
    );
    const planner = await f.launches.create(f.request, f.source, f.candidate);
    f.db.prepare("UPDATE pods SET status='complete' WHERE id=?").run(planner.id);
    const requirements: ExecutionRequirements = {
      version: 2,
      executables: [],
      platform: 'linux/amd64',
      requiredReferenceRepositories: [{ repositoryId: 'repo-b', commitSha: 'a'.repeat(40) }],
    };
    const request = {
      ...f.request,
      task: 'Implement matching brief',
      contract: generatedContract(requirements),
    };
    const parent = f.pods.getOrThrow(planner.id);
    const worker = await f.launches.createWorker(request, parent);
    const frozen = f.snapshots.get(worker.id);
    expect(frozen?.work.contract?.executionRequirements).toEqual(requirements);
    expect(frozen?.workflow.validationPhases).toEqual(['build', 'test']);
    vi.mocked(f.services.assertCapabilities).mockRejectedValue(
      new Error('Do not revalidate a receipt'),
    );
    vi.mocked(f.services.resolveEnvironment).mockRejectedValue(
      new Error('Do not resolve a receipt'),
    );
    f.services.referenceRevision = vi.fn(async () => {
      throw new Error('Do not rediscover a receipt');
    });
    vi.mocked(f.services.assertCapabilities).mockClear();
    vi.mocked(f.services.resolveEnvironment).mockClear();
    expect(await f.launches.createWorker(request, parent)).toEqual(worker);
    expect(f.create).toHaveBeenCalledTimes(2);
    expect(f.services.assertCapabilities).not.toHaveBeenCalled();
    expect(f.services.resolveEnvironment).not.toHaveBeenCalled();
    expect(f.services.referenceRevision).not.toHaveBeenCalled();
    expect(f.snapshots.get(worker.id)).toEqual(frozen);
    await expect(
      f.launches.createWorker(
        {
          ...request,
          contract: generatedContract({ version: 2, executables: [], platform: 'darwin/arm64' }),
        },
        parent,
      ),
    ).rejects.toMatchObject({ code: 'REQUEST_CONFLICT' });
    expect(f.create).toHaveBeenCalledTimes(2);
  });
  it('pins worker settings before planning and reuses the admitted result after profile and watcher edits', async () => {
    const f = fixture();
    expect(f.launches.target(f.source, 'autopod:arbitrary-profile')).toBeNull();
    expect(f.launches.target(f.source, 'autopod:alternate')).toMatchObject({ output: 'planner' });
    const planner = await f.launches.create(f.request, f.source, f.candidate);
    const frozen = f.snapshots.get(planner.id);
    expect(frozen).toMatchObject({
      workflow: { output: 'branch', validationPhases: [] },
      worker: { workflow: { output: 'pr', validationPhases: ['build', 'test'] } },
    });
    const flow = f.store.get('workflow', 'flow');
    f.store.write({
      ...flow,
      expectedRevision: flow.revision,
      payload: { ...flow.payload, validationPhases: ['review'], output: 'none' },
    });
    expect((await f.launches.create(f.request, f.source, f.candidate)).id).toBe(planner.id);
    f.bindings.write(
      {
        id: f.binding.id,
        expectedRevision: f.binding.revision,
        payload: { ...f.binding.payload, enabled: false, labelPrefix: 'new-prefix' },
      },
      'operator',
    );
    f.db.prepare("UPDATE pods SET status='complete' WHERE id=?").run(planner.id);
    const workerRequest = { ...f.request, task: 'Implement the planned change' };
    const worker = await f.launches.createWorker(workerRequest, f.pods.getOrThrow(planner.id));
    expect(f.snapshots.get(worker.id)).toMatchObject({
      workflow: { output: 'pr', validationPhases: ['build', 'test'] },
      derivation: { kind: 'watcher-worker', podId: planner.id },
    });
    expect(f.launches.readSource(worker.id)).toMatchObject({
      issueWatcherLabelPrefix: 'autopod',
      repoUrl: f.source.repoUrl,
    });
    vi.mocked(f.services.assertCapabilities).mockRejectedValueOnce(
      new Error('Provider temporarily unavailable'),
    );
    expect((await f.launches.createWorker(workerRequest, f.pods.getOrThrow(planner.id))).id).toBe(
      worker.id,
    );
    expect(f.create).toHaveBeenCalledTimes(2);
  });
  it('rejects changed watcher bindings during preflight and never starts an unselected sidecar', async () => {
    const f = fixture();
    vi.mocked(f.services.assertCapabilities).mockImplementationOnce(async () => {
      f.bindings.write(
        {
          id: f.binding.id,
          expectedRevision: f.binding.revision,
          payload: { ...f.binding.payload, enabled: false },
        },
        'operator',
      );
    });
    await expect(f.launches.create(f.request, f.source, f.candidate)).rejects.toThrow('changed');
    expect(f.create).not.toHaveBeenCalled();
    const current = f.bindings.get(f.binding.id);
    f.bindings.write(
      { id: current.id, expectedRevision: current.revision, payload: f.binding.payload },
      'operator',
    );
    const planner = await f.launches.create(f.request, f.source, f.candidate);
    f.db.prepare("UPDATE pods SET status='complete' WHERE id=?").run(planner.id);
    await expect(
      f.launches.createWorker(
        { ...f.request, requireSidecars: ['dagger'] },
        f.pods.getOrThrow(planner.id),
      ),
    ).rejects.toMatchObject({ code: 'WATCHER_SIDECAR_NOT_SELECTED' });
    expect(f.create).toHaveBeenCalledOnce();
    f.setReady(false);
    expect(f.launches.list()).toEqual([]);
    await expect(f.launches.create(f.request, f.source, f.candidate)).rejects.toMatchObject({
      code: 'CONFIG_CUTOVER_REQUIRED',
    });
  });
  it('refuses cross-repository routes and stale owner writes', () => {
    const f = fixture();
    expect(() =>
      f.bindings.write(
        {
          id: f.binding.id,
          expectedRevision: 1,
          payload: { ...f.binding.payload, targets: { elsewhere: { repositoryId: 'repo-b' } } },
        },
        'operator',
      ),
    ).toThrow('watched repository');
    expect(() =>
      f.bindings.write(
        { id: f.binding.id, expectedRevision: 1, payload: f.binding.payload },
        'someone-else',
      ),
    ).toThrow('owner');
    expect(f.bindings.get(f.binding.id).revision).toBe(1);
    expect(() => f.bindings.write({ payload: f.binding.payload }, 'operator')).toThrow(
      'already owns',
    );
  });
});
