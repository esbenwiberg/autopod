import type Database from 'better-sqlite3';
import type Dockerode from 'dockerode';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTestDb } from '../test-utils/mock-helpers.js';
import {
  addressPoolCapacity,
  addressPoolUsage,
  classifyNetworkHeadroom,
  DOCKER_BUILTIN_ADDRESS_POOLS,
  inspectNetworkCapacity,
  parseIpv4Cidr,
} from './docker-network-capacity.js';

const databases: Database.Database[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

/** Real SQLite with one retained checkpoint owning pod identity `held`. */
function retainedDatabase(): Database.Database {
  const db = createTestDb();
  databases.push(db);
  db.prepare('INSERT INTO retained_checkpoint_recoveries VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(
    'repair',
    'held',
    'task',
    1,
    'c'.repeat(64),
    'resource',
    '/original',
    'request-hash',
    JSON.stringify({ type: 'human', userId: 'operator' }),
    'Retain original evidence',
    JSON.stringify({ continuation: { prepareOnly: true } }),
    JSON.stringify({ result: {} }),
    'now',
  );
  return db;
}

interface FakeNetwork {
  Id: string;
  Name: string;
  Scope?: string;
  Labels?: Record<string, string>;
  IPAM?: { Config?: { Subnet?: string }[] };
  live?: Record<string, object> | Error;
}

function fakeDocker(networks: FakeNetwork[], info: unknown = {}) {
  return {
    info: vi.fn(async () => {
      if (info instanceof Error) throw info;
      return info;
    }),
    listNetworks: vi.fn(async () => networks),
    getNetwork: vi.fn((id: string) => ({
      inspect: vi.fn(async () => {
        const live = networks.find((network) => network.Id === id)?.live;
        if (live instanceof Error) throw live;
        return { Containers: live ?? {} };
      }),
    })),
  } as unknown as Dockerode & { getNetwork: ReturnType<typeof vi.fn> };
}

function podNetwork(identity: string, subnet: string, live?: FakeNetwork['live']): FakeNetwork {
  return {
    Id: `id-${identity}`,
    Name: `autopod-${identity}`,
    Scope: 'local',
    Labels: { 'com.autopod.pod-network': 'true', 'com.autopod.pod-id': identity },
    IPAM: { Config: [{ Subnet: subnet }] },
    live,
  };
}

describe('address-pool arithmetic', () => {
  it('matches Docker built-in pools: about 31 local subnets', () => {
    expect(addressPoolCapacity(DOCKER_BUILTIN_ADDRESS_POOLS)).toBe(31);
  });
  it('sizes a configured 10.200.0.0/16 pool with /24 subnets at 256 networks', () => {
    expect(addressPoolCapacity([{ base: '10.200.0.0/16', size: 24 }])).toBe(256);
  });
  it('ignores malformed pools and reports unknown when none are understood', () => {
    expect(addressPoolCapacity([{ base: 'nonsense', size: 24 }])).toBeNull();
    expect(addressPoolCapacity([{ base: '10.0.0.0/16', size: 8 }])).toBeNull();
    expect(parseIpv4Cidr('300.1.1.1/8')).toBeNull();
    expect(parseIpv4Cidr('fd00::/64')).toBeNull();
  });
  it('counts only subnets that fall inside a pool', () => {
    expect(
      addressPoolUsage(DOCKER_BUILTIN_ADDRESS_POOLS, [
        '172.17.0.0/16',
        '172.21.0.0/16',
        '192.168.16.0/20',
        '10.9.0.0/24',
        'fd00::/64',
      ]),
    ).toBe(3);
    // A manually created wider subnet consumes several pool-sized slots.
    expect(addressPoolUsage([{ base: '10.200.0.0/16', size: 24 }], ['10.200.0.0/22'])).toBe(4);
  });
  it('classifies reclaimable headroom', () => {
    expect(classifyNetworkHeadroom(null)).toBe('unknown');
    expect(classifyNetworkHeadroom(0)).toBe('critical');
    expect(classifyNetworkHeadroom(5)).toBe('warning');
    expect(classifyNetworkHeadroom(6)).toBe('ok');
  });
});

describe('inspectNetworkCapacity()', () => {
  it('reports exhausted built-in pools held by a retained checkpoint as critical', async () => {
    const db = retainedDatabase();
    const networks: FakeNetwork[] = [
      {
        Id: 'bridge',
        Name: 'bridge',
        Scope: 'local',
        IPAM: { Config: [{ Subnet: '172.17.0.0/16' }] },
      },
      podNetwork('held', '172.18.0.0/16'),
      podNetwork('active', '172.19.0.0/16', { container: {} }),
    ];
    // Fill the remaining built-in slots with unrelated networks.
    for (let index = 20; index <= 31; index++)
      networks.push({
        Id: `other-${index}`,
        Name: `other-${index}`,
        Scope: 'local',
        IPAM: { Config: [{ Subnet: `172.${index}.0.0/16` }] },
      });
    for (let index = 0; index < 16; index++)
      networks.push({
        Id: `lan-${index}`,
        Name: `lan-${index}`,
        Scope: 'local',
        IPAM: { Config: [{ Subnet: `192.168.${index * 16}.0/20` }] },
      });
    const capacity = await inspectNetworkCapacity({ docker: fakeDocker(networks), db });
    expect(capacity).toMatchObject({
      severity: 'critical',
      addressPools: { source: 'builtin-default', capacity: 31, used: 31, free: 0 },
      podNetworks: { total: 2, retained: 1, attached: 1, unattached: 1, reclaimable: 0 },
      reclaimableHeadroom: 0,
    });
  });

  // The fake exposes only read calls; any mutation attempt would surface as unknown.
  it('counts unattached non-retained pod networks as reclaimable headroom', async () => {
    const db = retainedDatabase();
    const docker = fakeDocker(
      [podNetwork('held', '10.200.0.0/24'), podNetwork('stale', '10.200.1.0/24')],
      { DefaultAddressPools: [{ Base: '10.200.0.0/16', Size: 24 }] },
    );
    const capacity = await inspectNetworkCapacity({ docker, db });
    expect(capacity).toMatchObject({
      severity: 'ok',
      addressPools: { source: 'configured', capacity: 256, used: 2, free: 254 },
      podNetworks: { total: 2, retained: 1, unattached: 2, reclaimable: 1, unknown: 0 },
      reclaimableHeadroom: 255,
    });
  });

  it('keeps unknown values null instead of reporting healthy capacity', async () => {
    const docker = fakeDocker(
      [podNetwork('a', '172.18.0.0/16', new Error('inspect failed'))],
      new Error('info unavailable'),
    );
    const capacity = await inspectNetworkCapacity({ docker });
    expect(capacity).toMatchObject({
      severity: 'unknown',
      addressPools: { source: 'unknown', capacity: null, used: null, free: null },
      podNetworks: { total: 1, retained: null, reclaimable: null, unknown: 1 },
      reclaimableHeadroom: null,
    });
  });
});
