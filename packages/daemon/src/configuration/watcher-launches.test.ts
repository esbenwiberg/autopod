import type { CreatePodRequest, EffectiveLaunchConfig } from '@autopod/shared';
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
describe('watcher launch snapshots', () => {
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
