import type { EffectiveLaunchConfig, SeriesLaunchRequest } from '@autopod/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPodRepository } from '../pods/pod-repository.js';
import { createTaskHistoryArchive } from '../pods/task-history-archive.js';
import {
  createTestConfiguration,
  insertConfigurationTestPod,
} from '../test-utils/configuration-helpers.js';
import { createTestDb } from '../test-utils/mock-helpers.js';
import { createLaunchSnapshotRepository } from './launch-snapshot.js';
import { createSeriesLaunches } from './series-launches.js';

const databases: ReturnType<typeof createTestDb>[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});
function fixture() {
  const db = createTestDb();
  databases.push(db);
  const { store, services } = createTestConfiguration(db);
  const snapshots = createLaunchSnapshotRepository(db, store);
  const pods = createPodRepository(db);
  let count = 0;
  let ready = true;
  const create = vi.fn((config: EffectiveLaunchConfig, owner: string) => {
    const id = `series-pod-${++count}`;
    insertConfigurationTestPod(db, id);
    db.prepare('UPDATE pods SET task=?,user_id=?,branch=?,series_id=? WHERE id=?').run(
      config.task,
      owner,
      config.work.branch ?? `autopod/${id}`,
      config.work.seriesId,
      id,
    );
    return pods.getOrThrow(id);
  });
  const launches = createSeriesLaunches({
    db,
    resolution: services,
    snapshots,
    ready: () => ready,
    create,
    read: (id) => pods.getForHistory?.(id) ?? pods.getOrThrow(id),
  });
  const request: SeriesLaunchRequest = {
    requestId: 'request',
    seriesName: 'Feature',
    launch: { repositoryId: 'repo-a' },
    briefs: [
      { title: 'Base', task: 'Build foundation', dependsOn: [] },
      { title: 'Next', task: 'Finish feature', dependsOn: ['Base'] },
    ],
  };
  return {
    db,
    store,
    services,
    snapshots,
    create,
    launches,
    request,
    pause: () => {
      ready = false;
    },
  };
}
describe('Atomic composable series', () => {
  it('freezes one selection and serializes single-PR branches without changing approval', async () => {
    const f = fixture();
    f.request.briefs.push({ title: 'Another root', task: 'Independent brief', dependsOn: [] });
    const result = await f.launches.create(f.request, 'operator');
    expect(f.services.resolveEnvironment).toHaveBeenCalledTimes(1);
    const configs = result.pods.map(({ pod }) => f.snapshots.get(pod.id));
    expect(configs.map((config) => config?.workflow.output)).toEqual(['branch', 'branch', 'pr']);
    expect(configs.every((config) => config?.workflow.completion === 'approval')).toBe(true);
    expect(new Set(result.pods.map(({ pod }) => pod.branch)).size).toBe(1);
    expect(configs[2]?.work.dependsOnPodIds).toContain(result.pods[1]?.pod.id);
    expect(configs[0]?.origin?.kind).toBe('series');
  });
  it('rolls back every pod, snapshot and receipt if a later creation fails', async () => {
    const f = fixture();
    f.create
      .mockImplementationOnce(() => {
        insertConfigurationTestPod(f.db, 'first');
        return createPodRepository(f.db).getOrThrow('first');
      })
      .mockImplementationOnce(() => {
        throw new Error('second insert failed');
      });
    await expect(f.launches.create(f.request, 'operator')).rejects.toThrow('second insert failed');
    for (const table of ['pods', 'pod_launch_snapshots', 'series_launch_receipts'])
      expect(f.db.prepare(`SELECT count(*) AS n FROM ${table}`).get()).toEqual({ n: 0 });
  });
  it('replays before preset reads and rejects changed payloads or owners', async () => {
    const f = fixture();
    const first = await f.launches.create(f.request, 'operator');
    f.pause();
    vi.mocked(f.services.resolveEnvironment).mockRejectedValue(new Error('offline'));
    expect(await f.launches.create(f.request, 'operator')).toEqual(first);
    expect(f.create).toHaveBeenCalledTimes(2);
    await expect(
      f.launches.create({ ...f.request, seriesName: 'Changed' }, 'operator'),
    ).rejects.toMatchObject({ code: 'REQUEST_CONFLICT' });
    await expect(f.launches.create(f.request, 'someone-else')).rejects.toMatchObject({
      code: 'REQUEST_CONFLICT',
    });
  });
  it('returns retained pod identities after deletion instead of admitting replacements', async () => {
    const f = fixture();
    const first = await f.launches.create(f.request, 'operator');
    const archive = createTaskHistoryArchive(f.db);
    for (const { pod } of first.pods) {
      f.db.transaction(() => {
        archive(pod.id);
        f.db.prepare('DELETE FROM pods WHERE id=?').run(pod.id);
      })();
    }
    const replay = await f.launches.create(f.request, 'operator');
    expect(replay.pods.map(({ pod }) => pod.id)).toEqual(first.pods.map(({ pod }) => pod.id));
    expect(f.create).toHaveBeenCalledTimes(2);
    expect(f.db.prepare('SELECT count(*) AS n FROM pods').get()).toEqual({ n: 0 });
  });
  it('rejects invalid graphs before discovery and rejects stale preset resolution atomically', async () => {
    const f = fixture();
    await expect(
      f.launches.create(
        { ...f.request, briefs: [{ title: 'Bad', task: 'Bad', dependsOn: ['Missing'] }] },
        'operator',
      ),
    ).rejects.toMatchObject({ code: 'SERIES_PREFLIGHT_FAILED' });
    expect(f.services.resolveEnvironment).not.toHaveBeenCalled();
    const original = f.services.assertCapabilities;
    let checks = 0;
    f.services.assertCapabilities = async (config) => {
      await original(config);
      if (++checks === 2) {
        const env = f.store.get('environment', 'env');
        f.store.write({
          id: env.id,
          kind: env.kind,
          name: 'Changed',
          payload: env.payload,
          expectedRevision: env.revision,
        });
      }
    };
    await expect(f.launches.create(f.request, 'operator')).rejects.toMatchObject({
      code: 'CONFIG_CHANGED',
    });
    expect(f.create).not.toHaveBeenCalled();
  });
  it('allocates an on-demand sidecar only to the brief that requests it', async () => {
    const f = fixture();
    const env = f.store.get('environment', 'env');
    f.store.write({
      id: env.id,
      kind: env.kind,
      name: env.name,
      expectedRevision: env.revision,
      payload: {
        ...env.payload,
        sidecars: [
          {
            id: 'cache',
            type: 'redis',
            image: `redis@sha256:${'a'.repeat(64)}`,
            version: '7',
            port: 6379,
          },
        ],
      },
    });
    const second = f.request.briefs[1];
    if (!second) throw new Error('Missing brief');
    second.requireSidecars = ['cache'];
    const result = await f.launches.create(f.request, 'operator');
    const allocations = result.pods.map(({ pod }) => {
      const config = f.snapshots.get(pod.id);
      if (!config) throw new Error('Missing snapshot');
      return Object.keys(config.resolvedExecution.sidecars);
    });
    expect(allocations).toEqual([[], ['cache']]);
  });
});
