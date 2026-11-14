import type Database from 'better-sqlite3';
import type Dockerode from 'dockerode';
import pino from 'pino';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  checkpointResourceIdentity,
  createRetainedCheckpointRepository,
} from '../pods/retained-checkpoint-repository.js';
import { createTestDb } from '../test-utils/mock-helpers.js';
import { DockerContainerManager } from './docker-container-manager.js';
import { DockerNetworkManager } from './docker-network-manager.js';

const logger = pino({ level: 'silent' });
const original = 'a'.repeat(64);
const databases: Database.Database[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});
function database() {
  const db = createTestDb();
  databases.push(db);
  return db;
}
function hold(
  db: Database.Database,
  activated = false,
  containerId = original,
  infrastructure = false,
) {
  db.prepare('INSERT INTO retained_checkpoint_recoveries VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(
    'repair',
    'pod',
    'task',
    1,
    containerId,
    'resource',
    '/original',
    'request-hash',
    JSON.stringify({ type: 'human', userId: 'operator' }),
    'Retain original evidence',
    JSON.stringify({
      continuation: {
        prepareOnly: true,
        ...(infrastructure
          ? {
              infrastructure: {
                version: 1,
                mode: 'checks',
                originalTree: 'b'.repeat(40),
                qualification: 'Owner selected preservation-safe recovery',
              },
            }
          : {}),
      },
    }),
    JSON.stringify({ result: {} }),
    'now',
  );
  if (activated)
    db.prepare(
      'INSERT INTO retained_checkpoint_recovery_events(recovery_id,kind,evidence,created_at) VALUES(?,?,?,?)',
    ).run('repair', 'activated', JSON.stringify({ generation: 2 }), 'now');
}
function dockerFixture(db: Database.Database | undefined) {
  const stale = {
    inspect: vi.fn(async () => ({
      Id: original,
      Config: { Labels: { 'dispatcher.spec-digest': 'spec' } },
      State: { Running: false },
    })),
    stop: vi.fn(async () => {}),
    remove: vi.fn(async () => {}),
    start: vi.fn(async () => {}),
  };
  const fresh = { id: 'b'.repeat(64), start: vi.fn(async () => {}), remove: vi.fn(async () => {}) };
  const docker = {
    createContainer: vi
      .fn()
      .mockRejectedValue(Object.assign(new Error('conflict'), { statusCode: 409 })),
    getContainer: vi.fn(() => stale),
    getImage: vi.fn(() => ({ inspect: vi.fn(async () => ({ Id: 'image' })) })),
  };
  const manager = new DockerContainerManager({
    docker: docker as unknown as Dockerode,
    logger,
    managedDatabase: db,
  });
  return {
    docker,
    stale,
    fresh,
    manager,
    config: { podId: 'pod', image: 'fixture-image', env: {} },
  };
}

describe('retained Docker constructor custody (real SQLite, provider doubles)', () => {
  it('permits one private prepared-original stop, never exec, wake, deletion or an out-of-scope stop', async () => {
    const db = database();
    hold(db, false, original, true);
    const repo = createRetainedCheckpointRepository(db);
    const f = dockerFixture(db);
    const assertCurrent = vi.fn();
    await expect(f.manager.stop(original)).rejects.toThrow('Original continuation resource');
    await expect(
      repo.stopOriginal('repair', () => f.manager.stop(original), assertCurrent),
    ).rejects.toThrow('owned prepared');
    repo.append('repair', 'prepared', {
      worktree: '/independent',
      head: 'a'.repeat(40),
      tree: 'b'.repeat(40),
    });
    await expect(
      repo.stopOriginal('repair', () => f.manager.stop(original), assertCurrent),
    ).rejects.toThrow('owned prepared');
    await repo.owned('repair', async () => {
      await repo.stopOriginal(
        'repair',
        async () => {
          expect(repo.get('repair')?.infrastructure?.stopDispatched).toBe(true);
          await expect(f.manager.kill(original)).rejects.toThrow('Original continuation resource');
          await expect(f.manager.start(original)).rejects.toThrow('Original continuation resource');
          await expect(f.manager.execInContainer(original, ['true'])).rejects.toThrow(
            'Original continuation resource',
          );
          await f.manager.stop(original);
        },
        assertCurrent,
      );
      await repo.stopOriginal('repair', () => f.manager.stop(original), assertCurrent);
    });
    expect(f.stale.stop).toHaveBeenCalledTimes(1);
    expect(f.stale.remove).not.toHaveBeenCalled();
    expect(f.stale.start).not.toHaveBeenCalled();
    await expect(f.manager.stop(original)).rejects.toThrow('Original continuation resource');
    const reopened = createRetainedCheckpointRepository(db);
    await reopened.owned('repair', () =>
      reopened.stopOriginal('repair', () => f.manager.stop(original), assertCurrent),
    );
    expect(f.stale.stop).toHaveBeenCalledTimes(1);
    expect(assertCurrent).toHaveBeenCalled();
  });
  it('refuses to stop/remove the held name collision before retrying create', async () => {
    const db = database();
    hold(db);
    const f = dockerFixture(db);
    await expect(f.manager.spawn(f.config)).rejects.toMatchObject({
      code: 'CHECKPOINT_ORIGINAL_RETAINED',
    });
    expect(f.stale.stop).not.toHaveBeenCalled();
    expect(f.stale.remove).not.toHaveBeenCalled();
    expect(f.docker.createContainer).toHaveBeenCalledOnce();
  });
  it('does not infer stale-cleanup authority without a custody database', async () => {
    const f = dockerFixture(undefined);
    await expect(f.manager.spawn(f.config)).rejects.toMatchObject({ statusCode: 409 });
    expect(f.stale.inspect).not.toHaveBeenCalled();
    expect(f.stale.stop).not.toHaveBeenCalled();
    expect(f.stale.remove).not.toHaveBeenCalled();
  });
  it.each(['unavailable', 'malformed'])('fails closed on %s conflict identity', async (mode) => {
    const f = dockerFixture(database());
    if (mode === 'unavailable')
      f.stale.inspect.mockRejectedValueOnce(new Error('inspection unavailable'));
    else
      f.stale.inspect.mockResolvedValueOnce({
        Id: '',
        Config: { Labels: { 'dispatcher.spec-digest': 'spec' } },
        State: { Running: false },
      });
    await expect(f.manager.spawn(f.config)).rejects.toThrow();
    expect(f.stale.stop).not.toHaveBeenCalled();
    expect(f.stale.remove).not.toHaveBeenCalled();
    expect(f.docker.createContainer).toHaveBeenCalledOnce();
  });
  it('rechecks custody after stop and never removes a newly held resource', async () => {
    const db = database();
    const f = dockerFixture(db);
    f.stale.stop.mockImplementationOnce(async () => {
      hold(db);
    });
    await expect(f.manager.spawn(f.config)).rejects.toMatchObject({
      code: 'CHECKPOINT_ORIGINAL_RETAINED',
    });
    expect(f.stale.stop).toHaveBeenCalledOnce();
    expect(f.stale.remove).not.toHaveBeenCalled();
    expect(f.docker.createContainer).toHaveBeenCalledOnce();
    expect(f.docker.getContainer).toHaveBeenLastCalledWith(original);
  });
  it('refuses managed reuse even when its spec label matches the retained original', async () => {
    const db = database();
    hold(db);
    const f = dockerFixture(db);
    const onCreated = vi.fn();
    await expect(
      f.manager.ensureManagedContainer({
        ...f.config,
        managedSpecDigest: 'spec',
        firewallScript: 'fixture',
        onCreated,
      }),
    ).rejects.toMatchObject({ code: 'CHECKPOINT_ORIGINAL_RETAINED' });
    expect(onCreated).not.toHaveBeenCalled();
    expect(f.stale.start).not.toHaveBeenCalled();
    expect(f.stale.remove).not.toHaveBeenCalled();
  });
  it('never discards an uncertain retained replacement allocation on a name conflict', async () => {
    const f = dockerFixture(database());
    await expect(
      f.manager.spawn({ ...f.config, resourceIdentity: 'pod-retained-fixture' }),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(f.stale.inspect).not.toHaveBeenCalled();
    expect(f.stale.stop).not.toHaveBeenCalled();
    expect(f.stale.remove).not.toHaveBeenCalled();
  });
  it('rechecks a hold recorded by onCreated before starting or failed-start cleanup', async () => {
    const db = database();
    const f = dockerFixture(db);
    f.docker.createContainer.mockResolvedValueOnce(f.fresh);
    await expect(
      f.manager.spawn({ ...f.config, onCreated: (id) => hold(db, false, id) }),
    ).rejects.toMatchObject({ code: 'CHECKPOINT_ORIGINAL_RETAINED' });
    expect(f.fresh.start).not.toHaveBeenCalled();
    expect(f.fresh.remove).not.toHaveBeenCalled();
  });
  it('rechecks managed ownership after its allocation callback', async () => {
    const db = database();
    const f = dockerFixture(db);
    await expect(
      f.manager.ensureManagedContainer({
        ...f.config,
        managedSpecDigest: 'spec',
        firewallScript: ':',
        onCreated: () => hold(db),
      }),
    ).rejects.toMatchObject({ code: 'CHECKPOINT_ORIGINAL_RETAINED' });
    expect(f.stale.start).not.toHaveBeenCalled();
    expect(f.stale.remove).not.toHaveBeenCalled();
  });
  it('uses a restart-stable replacement namespace without changing logical identity', async () => {
    const db = database();
    hold(db, true);
    const repo = createRetainedCheckpointRepository(db);
    const identity = repo.providerIdentity('pod', 2);
    expect(identity).toBe(checkpointResourceIdentity('pod', 'repair', 2));
    expect(identity).not.toBe('pod');
    expect(repo.providerIdentity('pod', 1)).toBe('pod');
    expect(createRetainedCheckpointRepository(db).providerIdentity('pod', 2)).toBe(identity);
    const f = dockerFixture(db);
    f.docker.createContainer.mockResolvedValueOnce(f.fresh);
    await expect(
      f.manager.spawn({ ...f.config, resourceIdentity: identity, env: { POD_ID: 'pod' } }),
    ).resolves.toBe(f.fresh.id);
    expect(f.docker.createContainer).toHaveBeenCalledWith(
      expect.objectContaining({ name: `autopod-${identity}`, Env: ['POD_ID=pod'] }),
    );
    expect(f.stale.stop).not.toHaveBeenCalled();
    expect(f.stale.remove).not.toHaveBeenCalled();
  });
});

function networkFixture(db: Database.Database) {
  const network = {
    inspect: vi.fn(async () => ({
      Id: 'network',
      Name: 'unrelated',
      Containers: {} as Record<string, object>,
    })),
    disconnect: vi.fn(async () => {}),
    remove: vi.fn(async () => {}),
  };
  const docker = {
    getNetwork: vi.fn(() => network),
    listNetworks: vi.fn(
      async () =>
        [] as Array<{
          Id: string;
          Name: string;
          Labels: Record<string, string>;
          Containers: Record<string, object>;
        }>,
    ),
    createNetwork: vi.fn(async () => ({})),
  };
  const manager = new DockerNetworkManager({
    docker: docker as unknown as Dockerode,
    logger,
    managedDatabase: db,
  });
  return { manager, docker, network };
}
describe('retained bridge custody (real SQLite, provider doubles)', () => {
  it('keeps original and replacement bridges after activation and across repository reconstruction', async () => {
    const db = database();
    hold(db, true);
    const f = networkFixture(db);
    for (const identity of ['pod', checkpointResourceIdentity('pod', 'repair', 2)]) {
      await expect(f.manager.destroyNetworkForPod(identity)).rejects.toMatchObject({
        code: 'CHECKPOINT_NETWORK_RETAINED',
      });
      await expect(f.manager.removeNetworkForPod(identity)).rejects.toMatchObject({
        code: 'CHECKPOINT_NETWORK_RETAINED',
      });
    }
    expect(f.network.remove).not.toHaveBeenCalled();
  });
  it('never force-detaches retained networks during startup orphan pruning', async () => {
    const db = database();
    hold(db, true);
    const f = networkFixture(db);
    f.docker.listNetworks.mockResolvedValueOnce(
      ['pod', checkpointResourceIdentity('pod', 'repair', 2)].map((id) => ({
        Id: id,
        Name: `autopod-${id}`,
        Labels: { 'com.autopod.pod-id': id },
        Containers: {},
      })),
    );
    expect(await f.manager.reconcileOrphanNetworks(new Set())).toBe(0);
    expect(f.network.disconnect).not.toHaveBeenCalled();
    expect(f.network.remove).not.toHaveBeenCalled();
  });
  it('protects a retained endpoint even on a differently named bridge', async () => {
    const db = database();
    hold(db);
    const f = networkFixture(db);
    f.docker.listNetworks.mockResolvedValueOnce([
      {
        Id: 'network',
        Name: 'unrelated',
        Labels: { 'com.autopod.pod-id': 'another' },
        Containers: {},
      },
    ]);
    f.network.inspect.mockResolvedValue({
      Id: 'network',
      Name: 'unrelated',
      Containers: { [original]: {} },
    });
    expect(await f.manager.reconcileOrphanNetworks(new Set())).toBe(0);
    expect(f.network.disconnect).not.toHaveBeenCalled();
    expect(f.network.remove).not.toHaveBeenCalled();
  });
  it('does not turn an unknown live inspection into teardown authority', async () => {
    const f = networkFixture(database());
    f.docker.listNetworks.mockResolvedValueOnce([
      {
        Id: 'network',
        Name: 'unrelated',
        Labels: { 'com.autopod.pod-id': 'another' },
        Containers: {},
      },
    ]);
    f.network.inspect.mockRejectedValueOnce(new Error('transport unavailable'));
    expect(await f.manager.reconcileOrphanNetworks(new Set())).toBe(0);
    expect(f.network.disconnect).not.toHaveBeenCalled();
    expect(f.network.remove).not.toHaveBeenCalled();
  });
  it('does not prune an apparently empty retained bridge on subnet exhaustion', async () => {
    const db = database();
    hold(db);
    const f = networkFixture(db);
    f.network.inspect.mockRejectedValueOnce(
      Object.assign(new Error('missing'), { statusCode: 404 }),
    );
    f.docker.createNetwork.mockRejectedValueOnce(
      new Error('all predefined address pools have been fully subnetted'),
    );
    f.docker.listNetworks.mockResolvedValueOnce([
      {
        Id: 'held-network',
        Name: 'autopod-pod',
        Labels: { 'com.autopod.pod-id': 'pod' },
        Containers: {},
      },
    ]);
    await f.manager.ensureNetworkForPod('another');
    expect(f.network.remove).not.toHaveBeenCalled();
    expect(f.docker.createNetwork).toHaveBeenCalledTimes(2);
  });
  it('fails with HOST_NETWORK_CAPACITY when only retained bridges remain after pruning', async () => {
    const db = database();
    hold(db);
    const f = networkFixture(db);
    f.network.inspect.mockRejectedValueOnce(
      Object.assign(new Error('missing'), { statusCode: 404 }),
    );
    const exhausted = () =>
      Object.assign(
        new Error(
          '(HTTP code 400) unexpected - all predefined address pools have been fully subnetted',
        ),
        { statusCode: 400 },
      );
    f.docker.createNetwork.mockRejectedValueOnce(exhausted()).mockRejectedValueOnce(exhausted());
    f.docker.listNetworks.mockResolvedValueOnce([
      {
        Id: 'held-network',
        Name: 'autopod-pod',
        Labels: { 'com.autopod.pod-id': 'pod' },
        Containers: {},
      },
    ]);
    const failure = f.manager.ensureNetworkForPod('another');
    await expect(failure).rejects.toMatchObject({
      code: 'HOST_NETWORK_CAPACITY',
      statusCode: 503,
    });
    await expect(failure).rejects.toThrow(
      /1 autopod networks exist; 1 are held by retained checkpoints, 0 are attached to containers, 0 unattached were pruned/,
    );
    expect(f.network.remove).not.toHaveBeenCalled();
  });
});
