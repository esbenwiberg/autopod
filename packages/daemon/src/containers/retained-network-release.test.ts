import type Database from 'better-sqlite3';
import type Dockerode from 'dockerode';
import pino from 'pino';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkpointResourceIdentity } from '../pods/retained-checkpoint-repository.js';
import { createTestDb, insertTestProfile } from '../test-utils/mock-helpers.js';
import { inspectNetworkCapacity } from './docker-network-capacity.js';
import { DockerNetworkManager } from './docker-network-manager.js';
import {
  planRetainedNetworkReleases,
  releaseRetainedNetwork,
  releaseRetainedNetworks,
  retainedNetworkReleaseScope,
} from './retained-network-release.js';

const logger = pino({ level: 'silent' });
const databases: Database.Database[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

const CURRENT = checkpointResourceIdentity('live', 'rec-live', 2);

function insertPod(db: Database.Database, id: string, status: string, generation = 1) {
  db.prepare(
    `INSERT INTO pods (id,profile_name,task,status,model,branch,user_id,lifecycle_generation)
     VALUES (?,?,?,?,?,?,?,?)`,
  ).run(id, 'proj', 'task', status, 'opus', 'main', 'u', generation);
}

function insertRecovery(
  db: Database.Database,
  id: string,
  podId: string,
  containerId: string,
  activatedGeneration?: number,
) {
  db.prepare('INSERT INTO retained_checkpoint_recoveries VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(
    id,
    podId,
    `task-${id}`,
    1,
    containerId,
    `resource-${id}`,
    `/worktrees/${id}`,
    `hash-${id}`,
    JSON.stringify({ type: 'human', userId: 'operator' }),
    'Retain original evidence',
    JSON.stringify({ continuation: { prepareOnly: true } }),
    JSON.stringify({ result: {} }),
    'now',
  );
  if (activatedGeneration)
    db.prepare(
      'INSERT INTO retained_checkpoint_recovery_events(recovery_id,kind,evidence,created_at) VALUES(?,?,?,?)',
    ).run(id, 'activated', JSON.stringify({ generation: activatedGeneration }), 'now');
}

function insertArtifactChecks(
  db: Database.Database,
  id: string,
  podId: string,
  identity: string,
  settled: boolean,
) {
  db.prepare('INSERT INTO artifact_checks_recoveries VALUES(?,?,?,?,?,?,?)').run(
    id,
    podId,
    `task-${id}`,
    `container-${id}`,
    `hash-${id}`,
    '{}',
    'now',
  );
  db.prepare(
    'INSERT INTO artifact_checks_recovery_events(recovery_id,kind,evidence,created_at) VALUES(?,?,?,?)',
  ).run(id, 'allocated', JSON.stringify({ identity, containerId: `alloc-${id}` }), 'now');
  if (settled)
    db.prepare(
      'INSERT INTO artifact_checks_recovery_events(recovery_id,kind,evidence,created_at) VALUES(?,?,?,?)',
    ).run(id, 'checked', '{}', 'now');
}

/**
 * Real SQLite custody:
 * - `live` is validating at generation 2; its original bridge is superseded and
 *   CURRENT (generation 2 replacement) is its current provider identity.
 * - `done` was killed; its retained original bridge is superseded.
 * - `fin` has a retained finalization and stays excluded.
 * - `art` failed (non-terminal); `art-old` checks settled, `art-new` checks still run.
 */
function database() {
  const db = createTestDb();
  databases.push(db);
  insertTestProfile(db, { name: 'proj' });
  insertPod(db, 'live', 'validating', 2);
  insertPod(db, 'done', 'killed');
  insertPod(db, 'fin', 'killed');
  insertPod(db, 'art', 'failed');
  insertRecovery(db, 'rec-live', 'live', 'c-live-original', 2);
  insertRecovery(db, 'rec-done', 'done', 'c-done-original');
  insertRecovery(db, 'rec-fin', 'fin', 'c-fin-original');
  db.prepare(
    'INSERT INTO retained_finalizations(pod_id,request_key,request_hash,binding,receipt) VALUES(?,?,?,?,?)',
  ).run('fin', 'request-fin', 'hash', '{}', '{}');
  insertArtifactChecks(db, 'ac-old', 'art', 'art-old', true);
  insertArtifactChecks(db, 'ac-new', 'art', 'art-new', false);
  return db;
}

interface FakeContainer {
  id: string;
  status: string;
}
interface FakeNetworkSpec {
  identity: string;
  created: string;
  endpoints?: Record<string, object>;
  containers?: FakeContainer[];
}

function fakeDocker(specs: FakeNetworkSpec[]) {
  const removed: string[] = [];
  const containerMutations = vi.fn();
  const removeFailures = new Map<string, Error>();
  const networks = specs.map((spec) => ({
    Id: `net-${spec.identity}`,
    Name: `autopod-${spec.identity}`,
    Created: spec.created,
    Scope: 'local',
    Driver: 'bridge',
    Internal: false,
    EnableIPv6: false,
    IPAM: { Config: [{ Subnet: '172.18.0.0/16', Gateway: '172.18.0.1' }] },
    Options: { 'com.docker.network.bridge.enable_icc': 'true' },
    Labels: { 'com.autopod.pod-network': 'true', 'com.autopod.pod-id': spec.identity },
    spec,
  }));
  const present = () => networks.filter((network) => !removed.includes(network.Id));
  const find = (key: string) => present().find((n) => n.Id === key || n.Name === key);
  const allContainers = new Map(
    specs.flatMap((spec) => (spec.containers ?? []).map((c) => [c.id, c] as const)),
  );
  const docker = {
    listNetworks: vi.fn(async () =>
      present().map(({ spec: _spec, ...network }) => ({ ...network, Containers: {} })),
    ),
    getNetwork: vi.fn((key: string) => ({
      inspect: vi.fn(async () => {
        const network = find(key);
        if (!network) throw Object.assign(new Error('network not found'), { statusCode: 404 });
        const { spec, ...info } = network;
        return { ...info, Containers: spec.endpoints ?? {} };
      }),
      remove: vi.fn(async () => {
        const network = find(key);
        if (!network) throw Object.assign(new Error('network not found'), { statusCode: 404 });
        const failure = removeFailures.get(network.Id);
        if (failure) throw failure;
        removed.push(network.Id);
      }),
    })),
    listContainers: vi.fn(async (options: { filters: string }) => {
      const key = JSON.parse(options.filters).network[0] as string;
      return (find(key)?.spec.containers ?? []).map((c) => ({ Id: c.id }));
    }),
    getContainer: vi.fn((id: string) => ({
      inspect: vi.fn(async () => {
        const container = allContainers.get(id);
        return {
          Id: id,
          Name: `/${id}`,
          State: { Running: container?.status === 'running', Status: container?.status },
        };
      }),
      start: containerMutations,
      stop: containerMutations,
      remove: containerMutations,
      kill: containerMutations,
    })),
    createNetwork: vi.fn(async () => ({})),
    info: vi.fn(async () => ({ DefaultAddressPools: [{ Base: '172.18.0.0/16', Size: 16 }] })),
  };
  return {
    docker: docker as unknown as Dockerode,
    mock: docker,
    removed,
    containerMutations,
    removeFailures,
  };
}

const standardNetworks: FakeNetworkSpec[] = [
  {
    identity: 'done',
    created: '2026-01-02T00:00:00Z',
    containers: [{ id: 'c-done-original', status: 'exited' }],
  },
  {
    identity: 'live',
    created: '2026-01-01T00:00:00Z',
    containers: [{ id: 'c-live-original', status: 'exited' }],
  },
  {
    identity: CURRENT,
    created: '2026-01-03T00:00:00Z',
    containers: [{ id: 'c-current', status: 'exited' }],
  },
  {
    identity: 'fin',
    created: '2026-01-01T00:00:00Z',
    containers: [{ id: 'c-fin-original', status: 'exited' }],
  },
  { identity: 'art', created: '2026-01-01T00:00:00Z' },
  {
    identity: 'art-old',
    created: '2026-01-04T00:00:00Z',
    containers: [{ id: 'alloc-old', status: 'paused' }],
  },
  { identity: 'art-new', created: '2026-01-01T00:00:00Z' },
  { identity: 'unrelated', created: '2026-01-01T00:00:00Z' },
];

describe('retainedNetworkReleaseScope()', () => {
  it('scopes checkpoint and artifact-check identities and protects current execution', () => {
    const scope = retainedNetworkReleaseScope(database());
    expect([...scope.inScope.keys()].sort()).toEqual(
      ['art', 'art-new', 'art-old', 'done', 'fin', 'live', CURRENT].sort(),
    );
    expect(scope.excludedPods).toEqual(new Set(['fin']));
    expect(scope.protectedIdentities.has(CURRENT)).toBe(true);
    expect(scope.protectedIdentities.has('live')).toBe(false);
    expect(scope.protectedIdentities.has('art')).toBe(true);
    expect(scope.protectedIdentities.has('art-new')).toBe(true);
    expect(scope.protectedIdentities.has('art-old')).toBe(false);
  });
});

describe('planRetainedNetworkReleases()', () => {
  it('reports only superseded, stopped, non-excluded bridges as eligible, oldest first', async () => {
    const f = fakeDocker(standardNetworks);
    const plan = await planRetainedNetworkReleases({ docker: f.docker, db: database(), logger });
    const byIdentity = Object.fromEntries(plan.map((c) => [c.identity, c]));
    expect(plan.filter((c) => c.eligible).map((c) => c.identity)).toEqual(['live', 'done']);
    expect(byIdentity[CURRENT]?.reason).toMatch(/current execution identity/);
    expect(byIdentity.fin?.reason).toMatch(/retained finalization or recovery fork/);
    expect(byIdentity.art?.reason).toMatch(/current execution identity/);
    expect(byIdentity['art-new']?.reason).toMatch(/current execution identity/);
    expect(byIdentity['art-old']?.reason).toMatch(/is paused, not stopped/);
    expect(byIdentity.unrelated).toBeUndefined();
    expect(f.removed).toEqual([]);
  });

  it('refuses a bridge with live endpoints or a live pod container', async () => {
    const db = database();
    db.prepare("UPDATE pods SET container_id='c-done-original' WHERE id='art'").run();
    const f = fakeDocker([
      {
        identity: 'done',
        created: '2026-01-02T00:00:00Z',
        containers: [{ id: 'c-done-original', status: 'exited' }],
      },
      {
        identity: 'live',
        created: '2026-01-01T00:00:00Z',
        containers: [{ id: 'c-live-original', status: 'exited' }],
        endpoints: { 'c-live-original': {} },
      },
    ]);
    const plan = await planRetainedNetworkReleases({ docker: f.docker, db, logger });
    expect(plan.map((c) => [c.identity, c.eligible, c.reason])).toEqual([
      ['live', false, 'Bridge has live endpoints'],
      ['done', false, expect.stringMatching(/belongs to a live pod/)],
    ]);
  });
});

describe('releaseRetainedNetwork()', () => {
  it('records the observed specification before removing exactly that bridge', async () => {
    const db = database();
    const f = fakeDocker(standardNetworks);
    const result = await releaseRetainedNetwork(
      { docker: f.docker, db, logger },
      { identity: 'live', networkId: 'net-live', networkName: 'autopod-live' },
      'operator',
      { type: 'human', userId: 'operator' },
    );
    expect(result).toMatchObject({ outcome: 'removed', identity: 'live' });
    expect(f.removed).toEqual(['net-live']);
    expect(f.containerMutations).not.toHaveBeenCalled();
    const record = db
      .prepare('SELECT * FROM retained_network_releases WHERE id=?')
      .get(result.releaseId) as Record<string, string>;
    expect(record).toMatchObject({
      identity: 'live',
      owner_pod_id: 'live',
      source: 'retained_checkpoint',
      network_id: 'net-live',
      network_name: 'autopod-live',
      trigger: 'operator',
    });
    expect(JSON.parse(record.spec as string)).toMatchObject({
      driver: 'bridge',
      ipam: { Config: [{ Subnet: '172.18.0.0/16' }] },
      labels: { 'com.autopod.pod-id': 'live' },
    });
    expect(JSON.parse(record.containers as string)).toEqual([
      { id: 'c-live-original', name: '/c-live-original', status: 'exited' },
    ]);
    expect(
      db
        .prepare('SELECT outcome FROM retained_network_release_outcomes WHERE release_id=?')
        .get(result.releaseId),
    ).toEqual({ outcome: 'removed' });
    expect(() => db.prepare('DELETE FROM retained_network_releases').run()).toThrow(
      /cannot be deleted/,
    );
    expect(() =>
      db.prepare("UPDATE retained_network_release_outcomes SET outcome='failed'").run(),
    ).toThrow(/immutable/);
  });

  it('refuses the current identity without recording or removing anything', async () => {
    const db = database();
    const f = fakeDocker(standardNetworks);
    const result = await releaseRetainedNetwork(
      { docker: f.docker, db, logger },
      { identity: CURRENT, networkId: `net-${CURRENT}`, networkName: `autopod-${CURRENT}` },
      'operator',
    );
    expect(result.outcome).toBe('refused');
    expect(f.removed).toEqual([]);
    expect(db.prepare('SELECT COUNT(*) AS n FROM retained_network_releases').get()).toEqual({
      n: 0,
    });
  });

  it('keeps the durable record and reports failure when Docker refuses removal', async () => {
    const db = database();
    const f = fakeDocker(standardNetworks);
    f.removeFailures.set(
      'net-live',
      Object.assign(new Error('has active endpoints'), { statusCode: 403 }),
    );
    const result = await releaseRetainedNetwork(
      { docker: f.docker, db, logger },
      { identity: 'live', networkId: 'net-live', networkName: 'autopod-live' },
      'subnet_pressure',
    );
    expect(result).toMatchObject({ outcome: 'failed', detail: 'has active endpoints' });
    expect(
      db
        .prepare(
          'SELECT r.trigger,o.outcome FROM retained_network_releases r JOIN retained_network_release_outcomes o ON o.release_id=r.id',
        )
        .get(),
    ).toEqual({ trigger: 'subnet_pressure', outcome: 'failed' });
  });

  it('operator release honours the limit, oldest first', async () => {
    const db = database();
    const f = fakeDocker(standardNetworks);
    const results = await releaseRetainedNetworks(
      { docker: f.docker, db, logger },
      { limit: 1, actor: { type: 'human', userId: 'operator' } },
    );
    expect(results.map((r) => [r.identity, r.outcome])).toEqual([['live', 'removed']]);
    expect(f.removed).toEqual(['net-live']);
  });
});

describe('subnet exhaustion releases superseded bridges (B1)', () => {
  const exhausted = () =>
    Object.assign(new Error('all predefined address pools have been fully subnetted'), {
      statusCode: 400,
    });

  it('releases oldest first and stops as soon as the pod network is created', async () => {
    const db = database();
    const f = fakeDocker(standardNetworks);
    f.mock.createNetwork
      .mockRejectedValueOnce(exhausted())
      .mockRejectedValueOnce(exhausted())
      .mockResolvedValueOnce({});
    const manager = new DockerNetworkManager({ docker: f.docker, logger, managedDatabase: db });
    expect(await manager.ensureNetworkForPod('new-pod')).toBe('autopod-new-pod');
    // The ordinary prune removes the unheld bridge first; only then is one
    // superseded retained bridge released.
    expect(f.removed).toEqual(['net-unrelated', 'net-live']);
    expect(f.mock.createNetwork).toHaveBeenCalledTimes(3);
    expect(db.prepare('SELECT identity,trigger FROM retained_network_releases').all()).toEqual([
      { identity: 'live', trigger: 'subnet_pressure' },
    ]);
    expect(f.containerMutations).not.toHaveBeenCalled();
  });

  it('fails with HOST_NETWORK_CAPACITY after releasing every eligible bridge', async () => {
    const db = database();
    const f = fakeDocker(standardNetworks);
    f.mock.createNetwork.mockRejectedValue(exhausted());
    const manager = new DockerNetworkManager({ docker: f.docker, logger, managedDatabase: db });
    await expect(manager.ensureNetworkForPod('new-pod')).rejects.toMatchObject({
      code: 'HOST_NETWORK_CAPACITY',
      message: expect.stringContaining('2 superseded retained bridges were released'),
    });
    expect(f.removed).toEqual(['net-unrelated', 'net-live', 'net-done']);
    expect(f.containerMutations).not.toHaveBeenCalled();
  });
});

describe('capacity reporting', () => {
  it('counts releasable superseded bridges as headroom', async () => {
    const f = fakeDocker(standardNetworks);
    const capacity = await inspectNetworkCapacity({ docker: f.docker, db: database(), logger });
    expect(capacity.podNetworks.releasable).toBe(2);
    expect(capacity.addressPools).toMatchObject({ capacity: 1, used: 8, free: 0 });
    // free 0 + reclaimable 1 (`unrelated`) + releasable 2
    expect(capacity.reclaimableHeadroom).toBe(3);
    expect(f.removed).toEqual([]);
  });
});
