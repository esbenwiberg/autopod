import type Database from 'better-sqlite3';
import type Dockerode from 'dockerode';
import pino from 'pino';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTestContext } from '../test-utils/mock-helpers.js';
import { inspectNetworkCapacity } from './docker-network-capacity.js';
import { DockerNetworkManager } from './docker-network-manager.js';

const podId = 'old-pod';
const containerId = 'a'.repeat(64);
const bridgeId = 'b'.repeat(64);
const bridgeName = `autopod-${podId}`;
const databases: Database.Database[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

function fixture() {
  const { db, podRepo } = createTestContext();
  databases.push(db);
  podRepo.insert({
    id: podId,
    task: 'Completed work',
    profileName: 'test-profile',
    status: 'complete',
    model: 'synthetic',
    runtime: 'codex',
    executionTarget: 'local',
    branch: podId,
    userId: 'operator',
    maxValidationAttempts: 2,
    skipValidation: false,
    outputMode: 'pr',
  });
  podRepo.update(podId, { containerId });
  const network = {
    Id: bridgeId,
    Name: bridgeName,
    Driver: 'bridge',
    Scope: 'local',
    Containers: {} as Record<string, object>,
    Labels: { 'com.autopod.pod-network': 'true', 'com.autopod.pod-id': podId },
    IPAM: { Config: [{ Subnet: '10.200.0.0/24' }] },
  };
  let exists = true;
  const remove = vi.fn(async () => {
    exists = false;
  });
  const inspect = vi.fn(async () => network);
  const disconnect = vi.fn();
  const mutateContainer = vi.fn();
  const containerInspect = vi.fn<() => Promise<unknown>>().mockRejectedValue({ statusCode: 404 });
  const mock = {
    info: async () => ({ DefaultAddressPools: [{ Base: '10.200.0.0/24', Size: 24 }] }),
    listNetworks: async () => (exists ? [network] : []),
    getNetwork: vi.fn((id: string) => ({
      inspect: id === bridgeId ? inspect : vi.fn().mockRejectedValue({ statusCode: 404 }),
      remove,
      disconnect,
    })),
    createNetwork: vi.fn(async () => {
      if (exists) throw new Error('all predefined address pools have been fully subnetted');
    }),
    getContainer: vi.fn(() => ({
      inspect: containerInspect,
      remove: mutateContainer,
      stop: mutateContainer,
    })),
    listContainers: vi
      .fn<(options: Dockerode.ContainerListOptions) => Promise<unknown[]>>()
      .mockResolvedValue([]),
  };
  const docker = mock as unknown as Dockerode;
  const manager = new DockerNetworkManager({
    docker,
    managedDatabase: db,
    logger: pino({ level: 'silent' }),
  });
  const holdBridge = () =>
    db
      .prepare(
        'INSERT INTO retained_finalizations(pod_id,request_key,request_hash,binding,receipt) VALUES(?,?,?,?,?)',
      )
      .run(podId, 'key', 'hash', '{}', '{}');
  return {
    db,
    podRepo,
    mock,
    network,
    inspect,
    remove,
    disconnect,
    mutateContainer,
    containerInspect,
    holdBridge,
    health: () => inspectNetworkCapacity({ docker, db }),
    allocate: () => manager.ensureNetworkForPod('new-pod'),
  };
}

describe('subnet pressure and completed Docker pods with stale container records', () => {
  it('counts a verified empty bridge without changing Docker, then removes only its exact ID under pressure', async () => {
    const f = fixture();
    expect(await f.health()).toMatchObject({
      addressPools: { free: 0 },
      podNetworks: { reclaimable: 1, blocked: 0, unknown: 0 },
      reclaimableHeadroom: 1,
    });
    expect(f.remove).not.toHaveBeenCalled();
    expect(f.mock.getContainer).toHaveBeenCalledWith(containerId);
    expect(f.mock.listContainers).toHaveBeenCalledWith({ all: true });
    expect(await f.allocate()).toBe('autopod-new-pod');
    expect(f.mock.getNetwork).toHaveBeenLastCalledWith(bridgeId);
    expect(f.remove).toHaveBeenCalledOnce();
    expect(f.disconnect).not.toHaveBeenCalled();
    expect(f.mutateContainer).not.toHaveBeenCalled();
    expect(f.podRepo.getOrThrow(podId)).toMatchObject({ containerId, status: 'complete' });
  });

  it.each([
    'container still exists',
    'disconnected container mode has a name reference',
    'disconnected container mode has an ID reference',
    'container network settings have a name reference',
    'container network settings have an ID reference',
    'label mismatch',
  ])('blocks cleanup and reports critical when %s', async (reason) => {
    const f = fixture();
    if (reason === 'container still exists')
      f.containerInspect.mockResolvedValue({ State: { Status: 'exited' } });
    if (reason.includes('reference')) {
      const name = reason.includes('name') ? bridgeName : 'alias';
      const id = reason.includes('ID') ? bridgeId : '';
      const mode = reason.includes('mode');
      f.mock.listContainers.mockResolvedValue([
        {
          Id: 'stopped',
          HostConfig: { NetworkMode: mode ? id || name : 'default' },
          NetworkSettings: { Networks: mode ? {} : { [name]: { NetworkID: id } } },
        },
      ]);
    }
    if (reason === 'label mismatch') f.network.Labels['com.autopod.pod-id'] = 'another-pod';
    expect(await f.health()).toMatchObject({
      severity: 'critical',
      podNetworks: { reclaimable: 0, blocked: 1, unknown: 0 },
    });
    await expect(f.allocate()).rejects.toMatchObject({ code: 'HOST_NETWORK_CAPACITY' });
    expect(f.remove).not.toHaveBeenCalled();
    expect(f.disconnect).not.toHaveBeenCalled();
  });

  it.each([
    'container inspection',
    'reference listing',
    'incomplete container summaries',
  ])('does not infer absence from failed %s', async (reason) => {
    const f = fixture();
    const failure = Object.assign(new Error('Docker unavailable'), { statusCode: 503 });
    if (reason === 'container inspection') f.containerInspect.mockRejectedValue(failure);
    else if (reason === 'reference listing') f.mock.listContainers.mockRejectedValue(failure);
    else f.mock.listContainers.mockResolvedValue([{ Id: 'unverified' }]);
    expect(await f.health()).toMatchObject({
      severity: 'critical',
      podNetworks: { reclaimable: 0, blocked: 0, unknown: 1 },
    });
    await expect(f.allocate()).rejects.toMatchObject({ code: 'HOST_NETWORK_CAPACITY' });
    expect(f.remove).not.toHaveBeenCalled();
  });

  it.each([
    { column: 'status', value: 'failed' },
    { column: 'status', value: 'killed' },
    { column: 'execution_target', value: 'sandbox' },
    { column: 'container_id', value: containerId.slice(0, 12) },
  ])('does not infer a stale Docker owner from $column=$value', async ({ column, value }) => {
    const f = fixture();
    f.db.prepare(`UPDATE pods SET ${column}=? WHERE id=?`).run(value, podId);
    expect(await f.health()).toMatchObject({ podNetworks: { reclaimable: 0, blocked: 1 } });
    await expect(f.allocate()).rejects.toMatchObject({ code: 'HOST_NETWORK_CAPACITY' });
    expect(f.mock.getContainer).not.toHaveBeenCalled();
    expect(f.remove).not.toHaveBeenCalled();
  });

  it('does not offer the ordinary pressure path for a retained bridge', async () => {
    const f = fixture();
    f.holdBridge();
    expect(await f.health()).toMatchObject({ podNetworks: { retained: 1, reclaimable: 0 } });
    await expect(f.allocate()).rejects.toMatchObject({ code: 'HOST_NETWORK_CAPACITY' });
    expect(f.mock.getContainer).not.toHaveBeenCalled();
    expect(f.remove).not.toHaveBeenCalled();
  });

  it.each([
    'new custody',
    'new generation',
    'new endpoints',
  ])('rechecks %s after inspecting the old owner', async (race) => {
    const f = fixture();
    f.inspect
      .mockImplementationOnce(async () => f.network)
      .mockImplementationOnce(async () => {
        if (race === 'new custody') f.holdBridge();
        if (race === 'new generation')
          f.db.prepare('UPDATE pods SET lifecycle_generation=2 WHERE id=?').run(podId);
        if (race === 'new endpoints') f.network.Containers['new-endpoint'] = {};
        return f.network;
      });
    await expect(f.allocate()).rejects.toMatchObject({ code: 'HOST_NETWORK_CAPACITY' });
    expect(f.remove).not.toHaveBeenCalled();
    expect(f.disconnect).not.toHaveBeenCalled();
  });
});
