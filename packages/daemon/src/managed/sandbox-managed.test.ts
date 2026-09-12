import { readFileSync } from 'node:fs';
import type { ManagedPodRequest } from '@autopod/shared';
import Database from 'better-sqlite3';
import pino from 'pino';
import { expect, it, vi } from 'vitest';
import type { CreateSandboxOptions, SandboxApiClient } from '../containers/sandbox-api-client.js';
import { SandboxContainerManager } from '../containers/sandbox-container-manager.js';
import type { ContainerManager } from '../interfaces/container-manager.js';
import { ManagedContainerRuntime } from './container-runtime.js';

it('reconciles a lost Sandbox create response by exact labels and never creates a replacement after uncertainty', async () => {
  const db = new Database(':memory:');
  db.exec(
    readFileSync(
      new URL('../db/migrations/149_managed_sandbox_allocations.sql', import.meta.url),
      'utf8',
    ),
  );
  let id: string | null = null;
  let creates = 0;
  let lose = true;
  let bound = '';
  const client = {
    async findManagedSandbox(_pod: string, digest: string) {
      if (id && bound !== digest) throw new Error('identity-conflict');
      return id;
    },
    async createSandbox(options: CreateSandboxOptions) {
      creates++;
      expect(options.egressPolicy.trafficInspection).toBe('Full');
      bound = options.managedSpecDigest!;
      id = 'sandbox-one';
      if (lose) {
        lose = false;
        throw new Error('lost-response');
      }
      return id;
    },
    async getStatus() {
      return 'running';
    },
    async updateEgress() {},
    async exec() {
      return { exitCode: 0, stdout: '', stderr: '' };
    },
  } as unknown as SandboxApiClient;
  const config = {
    podId: 'managed-one',
    image: `registry.invalid/worker@sha256:${'a'.repeat(64)}`,
    env: {},
    networkPolicyMode: 'deny-all' as const,
    managedSpecDigest: `sha256:${'1'.repeat(64)}`,
  };
  const manager = () =>
    new SandboxContainerManager(client, pino({ level: 'silent' }), { managedDatabase: db });
  try {
    await expect(manager().ensureManagedContainer(config)).rejects.toThrow('lost-response');
    expect(await manager().ensureManagedContainer(config)).toBe('sandbox-one');
    expect(creates).toBe(1);
    expect(await manager().ensureManagedContainer(config)).toBe('sandbox-one');
    await expect(
      manager().ensureManagedContainer({
        ...config,
        managedSpecDigest: `sha256:${'2'.repeat(64)}`,
      }),
    ).rejects.toThrow('conflict');
    id = null;
    await expect(manager().ensureManagedContainer(config)).rejects.toThrow('identity-missing');
    expect(creates).toBe(1);
    db.prepare(
      "INSERT INTO managed_sandbox_allocations(pod_id,spec_digest,phase) VALUES (?,?,'creating')",
    ).run('managed-two', config.managedSpecDigest);
    await expect(
      manager().ensureManagedContainer({ ...config, podId: 'managed-two' }),
    ).rejects.toThrow('create-uncertain');
    expect(creates).toBe(1);
  } finally {
    db.close();
  }
});
it('a suspended Sandbox is not observed exit, and an unavailable sandbox route never falls back to Docker', async () => {
  const request = JSON.parse(
    readFileSync(
      new URL('../../../../specs/managed-pod/v1/examples.json', import.meta.url),
      'utf8',
    ),
  ).ManagedPodRequest as ManagedPodRequest;
  request.route.executionTarget = 'sandbox';
  const local = vi.fn();
  const manager = {
    ensureManagedContainer: vi.fn(),
    extractManagedOutput: vi.fn(),
    execInContainer: async () => ({ exitCode: 1, stdout: '', stderr: '' }),
    getStatus: async () => 'stopped',
  } as unknown as ContainerManager;
  const boundary = {
    route: request.route,
    manager,
    image: `registry.invalid/worker@sha256:${'a'.repeat(64)}`,
    command: ['worker', request.route.model],
    prepare: local,
    quotaReady: async () => true,
    attachProviderChannel: async () => {},
  };
  const runtime = new ManagedContainerRuntime(
    [boundary],
    () => ({ request, podId: 'managed-one', createdAt: 100 }),
    'supervisor',
  );
  expect(await runtime.observe('sandbox-one')).toEqual({ state: 'unknown', consumedTokens: 0 });
  await expect(
    runtime.preflight({ ...request, route: { ...request.route, executionTarget: 'local' } }),
  ).rejects.toThrow('route-unavailable');
  expect(local).not.toHaveBeenCalled();
});
