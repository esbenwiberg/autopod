import { describe, expect, it, vi } from 'vitest';
import { createActionAuditRepository } from '../actions/audit-repository.js';
import { validateTransition } from '../pods/state-machine.js';
import {
  createTestConfiguration,
  insertConfigurationTestPod,
} from '../test-utils/configuration-helpers.js';
import { createTestContext } from '../test-utils/mock-helpers.js';
import { resolveLaunch } from './launch-resolver.js';
import { createLaunchSnapshotRepository } from './launch-snapshot.js';
import { createScopedPodTools } from './scoped-pod-tools.js';

describe('composable scoped tool integration', () => {
  it('uses frozen service rules and rechecks operator revocation before releasing data', async () => {
    const ctx = createTestContext();
    try {
      const { store, services } = createTestConfiguration(ctx.db);
      const repo = store.get('repository', 'repo-a');
      store.write({
        id: repo.id,
        kind: repo.kind,
        name: repo.name,
        expectedRevision: repo.revision,
        payload: {
          ...repo.payload,
          setups: repo.payload.setups.map((setup) => ({
            ...setup,
            integrations: {
              ...setup.integrations,
              serviceAccess: [
                {
                  id: 'ado-read',
                  service: 'ado',
                  organization: 'org',
                  project: 'project',
                  repository: 'repo',
                  operations: ['code.file'],
                },
              ],
            },
          })),
        },
      });
      const config = await resolveLaunch({ repositoryId: repo.id, task: 'Read source' }, services);
      const snapshots = createLaunchSnapshotRepository(ctx.db, store);
      snapshots.admit({
        config,
        requestDigest: 'service-request',
        createPod: () => insertConfigurationTestPod(ctx.db, 'service-pod'),
      });
      for (const status of ['provisioning', 'running'] as const) {
        validateTransition('service-pod', ctx.podRepo.getOrThrow('service-pod').status, status);
        ctx.podRepo.update('service-pod', { status });
      }
      let revoked = false;
      const request = vi.fn(async () => {
        revoked = true;
        return { content: 'private content' };
      });
      const tools = createScopedPodTools({
        db: ctx.db,
        pods: ctx.podRepo,
        snapshots,
        github: { get: vi.fn(), mutate: vi.fn(), download: vi.fn() },
        audit: createActionAuditRepository(ctx.db),
        githubCeiling: async (saved) => saved.githubAccess,
        assertPimAllowed: vi.fn(),
        serviceReads: {
          transport: { request },
          assertAllowed() {
            if (revoked) throw new Error('revoked');
          },
        },
      });
      const selected = tools.get('service-pod');
      expect(await selected?.serviceRules?.()).toHaveLength(1);
      await expect(
        selected?.serviceRead?.({
          service: 'ado',
          ruleId: 'ado-read',
          operation: 'code.file',
          path: '/README.md',
          limit: 30,
        }),
      ).rejects.toThrow('revoked');
      expect(request).toHaveBeenCalledOnce();
      await expect(selected?.serviceRules?.()).rejects.toThrow('revoked');
    } finally {
      ctx.db.close();
    }
  });
  it('uses the saved grant across preset edits, withholds writes, and rechecks cancellation', async () => {
    const ctx = createTestContext();
    try {
      const { store, services } = createTestConfiguration(ctx.db);
      const repo = store.get('repository', 'repo-a');
      store.write({
        id: repo.id,
        kind: repo.kind,
        name: repo.name,
        expectedRevision: repo.revision,
        payload: { ...repo.payload, providerRepositoryId: '1' },
      });
      const config = await resolveLaunch({ repositoryId: repo.id, task: 'Debug' }, services);
      const snapshots = createLaunchSnapshotRepository(ctx.db, store);
      snapshots.admit({
        config,
        requestDigest: 'request',
        createPod: () => insertConfigurationTestPod(ctx.db, 'pod'),
      });
      const updateStatus = (status: 'provisioning' | 'running' | 'killing') => {
        validateTransition('pod', ctx.podRepo.getOrThrow('pod').status, status);
        ctx.podRepo.update('pod', { status });
      };
      updateStatus('provisioning');
      updateStatus('running');
      const github = {
        get: vi.fn(
          async (path: string): Promise<unknown> =>
            path === '/repositories/1'
              ? { id: 1, name: 'repo-a', default_branch: 'main', owner: { id: 2, login: 'org' } }
              : { content: 'fixture' },
        ),
        mutate: vi.fn(),
        download: vi.fn(),
      };
      const tools = createScopedPodTools({
        db: ctx.db,
        pods: ctx.podRepo,
        snapshots,
        github,
        audit: createActionAuditRepository(ctx.db),
        githubCeiling: async (saved) => saved.githubAccess,
        assertPimAllowed: vi.fn(),
        pim: {
          eligibility: { discover: vi.fn(), selected: vi.fn() },
          activation: { request: vi.fn(), release: vi.fn() },
        },
      });
      const access = store.get('githubAccess', 'access');
      store.write({
        id: access.id,
        kind: access.kind,
        name: access.name,
        expectedRevision: access.revision,
        payload: { rules: [] },
      });
      const podTools = tools.get('pod');
      expect(podTools?.githubMutate).toBeUndefined();
      expect(podTools?.pimActivate).toBeUndefined();
      expect(
        await podTools?.githubRead?.({
          repositoryId: '1',
          resource: 'code.file',
          path: 'README.md',
          ref: 'main',
        }),
      ).toMatchObject({ data: { content: 'fixture' } });
      expect(github.mutate).not.toHaveBeenCalled();
      updateStatus('killing');
      await expect(
        podTools?.githubRead?.({
          repositoryId: '1',
          resource: 'code.file',
          path: 'README.md',
          ref: 'main',
        }),
      ).rejects.toThrow('running pod');
    } finally {
      ctx.db.close();
    }
  });
});
