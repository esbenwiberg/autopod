import type Dockerode from 'dockerode';
import pino from 'pino';
import { describe, expect, it, vi } from 'vitest';
import { createTestContext } from '../test-utils/mock-helpers.js';
import { DockerNetworkManager } from './docker-network-manager.js';

function fixture(orphan = false) {
  const ctx = createTestContext();
  const insert = (id: string) =>
    ctx.podRepo.insert({
      id,
      profileName: 'test-profile',
      task: 'Provision owned source',
      status: 'provisioning',
      model: 'synthetic',
      runtime: 'codex',
      executionTarget: 'local',
      branch: id,
      userId: 'operator',
      maxValidationAttempts: 2,
      skipValidation: false,
      outputMode: 'pr',
    });
  insert('pending-a');
  insert('pending-b');
  type Network = {
    Id: string;
    Name: string;
    Labels: Record<string, string>;
    Containers: Record<string, object>;
  };
  const networks = new Map<string, Network>();
  const add = (id: string, attached = false) => {
    const name = `autopod-${id}`;
    networks.set(name, {
      Id: name,
      Name: name,
      Labels: { 'com.autopod.pod-network': 'true', 'com.autopod.pod-id': id },
      Containers: attached ? { 'existing-container': {} } : {},
    });
  };
  add('attached', true);
  if (orphan) add('unowned');
  const removed: string[] = [];
  const inspect = vi.fn((name: string) => {
    const n = networks.get(name);
    if (!n) throw Object.assign(new Error('not found'), { statusCode: 404 });
    return n;
  });
  const docker = {
    getNetwork: (name: string) => ({
      inspect: async () => inspect(name),
      remove: async () => {
        removed.push(name);
        networks.delete(name);
      },
      disconnect: vi.fn(),
    }),
    createNetwork: async (options: { Name: string; Labels: Record<string, string> }) => {
      if (networks.size >= (orphan ? 3 : 2))
        throw new Error('all predefined address pools have been fully subnetted');
      add(options.Labels['com.autopod.pod-id'] ?? 'invalid');
      return { id: options.Name };
    },
    listNetworks: async () => [...networks.values()],
  } as unknown as Dockerode;
  // Separate instances sharing durable ownership: an in-memory allocation set is insufficient.
  const manager = () =>
    new DockerNetworkManager({
      docker,
      managedDatabase: ctx.db,
      logger: pino({ level: 'silent' }),
    });
  return { ...ctx, insert, add, networks, removed, inspect, manager, docker };
}

describe('pod network provisioning interleavings', () => {
  it('refuses capacity rather than deleting another pending allocation across managers', async () => {
    const f = fixture();
    try {
      const first = await f.manager().ensureNetworkForPod('pending-a');
      await expect(f.manager().ensureNetworkForPod('pending-b')).rejects.toMatchObject({
        code: 'HOST_NETWORK_CAPACITY',
      });
      expect(f.networks.has(first)).toBe(true);
      expect(f.removed).toEqual([]);
      expect(f.podRepo.getOrThrow('pending-a').status).toBe('provisioning');
    } finally {
      f.db.close();
    }
  });

  it('reclaims a genuinely unowned bridge without deleting the pending allocation', async () => {
    const f = fixture(true);
    try {
      await f.manager().ensureNetworkForPod('pending-a');
      expect(await f.manager().ensureNetworkForPod('pending-b')).toBe('autopod-pending-b');
      expect(f.removed).toEqual(['autopod-unowned']);
      expect(f.networks.has('autopod-pending-a')).toBe(true);
      expect(f.networks.has('autopod-attached')).toBe(true);
    } finally {
      f.db.close();
    }
  });

  it('does not let a stale startup active-set override durable provisioning ownership', async () => {
    const f = fixture();
    try {
      await f.manager().ensureNetworkForPod('pending-a');
      // Omit the attached unrelated fixture to focus the reconciler on A.
      f.networks.delete('autopod-attached');
      expect(await f.manager().reconcileOrphanNetworks(new Set())).toBe(0);
      expect(f.removed).toEqual([]);
      await f.manager().removeNetworkForPod('pending-a');
      expect(f.removed).toEqual(['autopod-pending-a']); // exact-owner cleanup is not GC
    } finally {
      f.db.close();
    }
  });

  it.each([
    'preparing',
    'running',
    'uncertain',
    'completed',
    'failed',
  ] as const)('preserves %s isolated reviewer/advisor ownership', async (state) => {
    const f = fixture();
    try {
      f.networks.delete('autopod-attached');
      const id = 'review-pending';
      f.add(id);
      f.db
        .prepare(`INSERT INTO isolated_reviewer_runs
        (id,pod_id,lifecycle_generation,configuration_digest,account_id,runtime,model,execution_target,state,cleanup,created_at,updated_at)
        VALUES(?, 'pending-a',1,'digest','account','codex','synthetic','local',?,'uncertain','now','now')`)
        .run(id, state);
      expect(await f.manager().reconcileOrphanNetworks(new Set())).toBe(0);
      expect(f.removed).toEqual([]);
    } finally {
      f.db.close();
    }
  });

  it.each([
    'system-unknown',
    'deploy-unknown',
    'review-unknown',
    'pending-a-artifact-checks-unknown',
  ])('retains unverified ownership for %s', async (id) => {
    const f = fixture();
    try {
      f.networks.clear();
      f.add(id);
      expect(await f.manager().reconcileOrphanNetworks(new Set())).toBe(0);
      expect(f.removed).toEqual([]);
    } finally {
      f.db.close();
    }
  });

  it('rechecks a new durable claim after live inspection and before removal', async () => {
    const f = fixture(true);
    try {
      await f.manager().ensureNetworkForPod('pending-a');
      const original = f.inspect.getMockImplementation()!;
      f.inspect.mockImplementation((name) => {
        const result = original(name);
        if (name === 'autopod-unowned') f.insert('unowned');
        return result;
      });
      await expect(f.manager().ensureNetworkForPod('pending-b')).rejects.toMatchObject({
        code: 'HOST_NETWORK_CAPACITY',
      });
      expect(f.removed).toEqual([]);
    } finally {
      f.db.close();
    }
  });

  it.each([
    false,
    true,
  ])('does not infer GC authority from unavailable ownership (database missing=%s)', async (missing) => {
    const f = fixture();
    const prepare = vi.spyOn(f.db, 'prepare');
    try {
      f.networks.clear();
      f.add('unowned');
      const manager = missing
        ? new DockerNetworkManager({ docker: f.docker, logger: pino({ level: 'silent' }) })
        : f.manager();
      if (!missing)
        prepare.mockImplementation(() => {
          throw new Error('ownership store unavailable');
        });
      expect(await manager.reconcileOrphanNetworks(new Set())).toBe(0);
      expect(f.removed).toEqual([]);
    } finally {
      prepare.mockRestore();
      f.db.close();
    }
  });

  it('does not remove a bridge whose live inspection fails', async () => {
    const f = fixture(true);
    try {
      await f.manager().ensureNetworkForPod('pending-a');
      const original = f.inspect.getMockImplementation()!;
      f.inspect.mockImplementation((name) => {
        if (name === 'autopod-unowned') throw new Error('inspection unavailable');
        return original(name);
      });
      await expect(f.manager().ensureNetworkForPod('pending-b')).rejects.toMatchObject({
        code: 'HOST_NETWORK_CAPACITY',
      });
      expect(f.removed).toEqual([]);
    } finally {
      f.db.close();
    }
  });
});
