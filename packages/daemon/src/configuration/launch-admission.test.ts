import { describe, expect, it, vi } from 'vitest';
import { createTaskHistoryArchive } from '../pods/task-history-archive.js';
import {
  createTestConfiguration,
  insertConfigurationTestPod,
} from '../test-utils/configuration-helpers.js';
import { createTestDb } from '../test-utils/mock-helpers.js';
import { configurationDigest } from './configuration-digest.js';
import { deriveLaunch } from './derive-launch.js';
import { admitLaunch } from './launch-admission.js';
import { createLaunchSnapshotRepository } from './launch-snapshot.js';

describe('launch admission retries', () => {
  it.each([
    undefined,
    () => undefined,
  ])('fails closed before resolving or inserting a guarded launch with no enrollment', async (authorize) => {
    const db = createTestDb();
    try {
      const { store, services } = createTestConfiguration(db);
      const snapshots = createLaunchSnapshotRepository(db, store);
      const createPod = vi.fn();
      const preparePod = vi.fn();
      await expect(
        admitLaunch({
          request: {
            repositoryId: 'repo-a',
            task: 'Parent',
            requestId: '11111111-1111-4111-8111-111111111111',
            expectedDigest: 'a'.repeat(64),
            requireParentEnrollment: true,
          },
          actorId: 'user',
          services,
          snapshots,
          authorize,
          createPod,
          preparePod,
        }),
      ).rejects.toMatchObject({ code: 'PARENT_ENROLLMENT_REQUIRED', statusCode: 409 });
      expect(services.resolveEnvironment).not.toHaveBeenCalled();
      expect(preparePod).not.toHaveBeenCalled();
      expect(createPod).not.toHaveBeenCalled();
      expect(db.prepare('SELECT count(*) FROM pods').pluck().get()).toBe(0);
      expect(db.prepare('SELECT count(*) FROM pod_launch_snapshots').pluck().get()).toBe(0);
    } finally {
      db.close();
    }
  });

  it('rolls back the ordinary task when the synchronous parent binding is rejected', async () => {
    const db = createTestDb();
    try {
      const { store, services } = createTestConfiguration(db);
      const snapshots = createLaunchSnapshotRepository(db, store);
      await expect(
        admitLaunch({
          request: { repositoryId: 'repo-a', task: 'Parent', requestId: 'parent-test' },
          actorId: 'user',
          services,
          snapshots,
          createPod: () => insertConfigurationTestPod(db, 'parent-test'),
          authorize: () => () => {
            expect(db.inTransaction).toBe(true);
            expect(db.prepare('SELECT id FROM pods WHERE id=?').pluck().get('parent-test')).toBe(
              'parent-test',
            );
            throw new Error('Parent binding rejected');
          },
        }),
      ).rejects.toThrow('Parent binding rejected');
      expect(db.prepare('SELECT count(*) FROM pods').pluck().get()).toBe(0);
      expect(db.prepare('SELECT count(*) FROM pod_launch_snapshots').pluck().get()).toBe(0);
    } finally {
      db.close();
    }
  });

  it('spawns a workspace worker from its frozen template, including references, without copying parent series identity', async () => {
    const db = createTestDb();
    try {
      const { store, services } = createTestConfiguration(db);
      const profile = store.get('profile', 'profile');
      store.write({ id: 'worker', kind: 'profile', name: 'Worker', payload: profile.payload });
      store.write({
        ...profile,
        expectedRevision: profile.revision,
        payload: { ...profile.payload, workerProfileId: 'worker' },
      });
      const snapshots = createLaunchSnapshotRepository(db, store);
      services.readLaunch = snapshots.get;
      const parent = await admitLaunch({
        request: {
          repositoryId: 'repo-a',
          task: 'Plan',
          overrides: { workflow: { agentMode: 'interactive', validationPhases: [] } },
          referenceRepositories: [{ repositoryId: 'repo-b', ref: 'main', access: 'read' }],
          work: { seriesId: 'old-series', seriesName: 'Old series' },
        },
        actorId: 'user',
        services,
        snapshots,
        createPod: () => insertConfigurationTestPod(db, 'workspace'),
      });
      const env = store.get('environment', 'env');
      store.write({
        ...env,
        expectedRevision: env.revision,
        payload: { ...env.payload, template: 'node24' },
      });
      const request = {
        repositoryId: 'repo-a',
        task: 'Implement the plan',
        source: { podId: 'workspace', digest: parent.config.digest, configuration: 'worker' },
      };
      const child = await admitLaunch({
        request,
        actorId: 'user',
        services,
        snapshots,
        createPod: () => insertConfigurationTestPod(db, 'worker-child'),
      });
      expect(child.config).toMatchObject({
        profileId: 'worker',
        workflow: { agentMode: 'auto' },
        environment: { template: 'node22' },
      });
      expect(child.config.references).toEqual(parent.config.references);
      expect(child.config.work.seriesId).toBeUndefined();
      await expect(
        admitLaunch({
          request: { ...request, requiredSidecarIds: ['unselected'] },
          actorId: 'user',
          services,
          snapshots,
          createPod: vi.fn(),
        }),
      ).rejects.toMatchObject({ code: 'FROZEN_WORKER_SIDECAR_MISSING' });
    } finally {
      db.close();
    }
  });
  it('supports original or current follow-ups without silently rereading edited presets', async () => {
    const db = createTestDb();
    try {
      const { store, services } = createTestConfiguration(db);
      const snapshots = createLaunchSnapshotRepository(db, store);
      services.readLaunch = snapshots.get;
      const parent = await admitLaunch({
        request: { repositoryId: 'repo-a', task: 'Original' },
        actorId: 'user',
        services,
        snapshots,
        createPod: () => insertConfigurationTestPod(db, 'source'),
      });
      const env = store.get('environment', 'env');
      store.write({
        ...env,
        expectedRevision: env.revision,
        payload: { ...env.payload, template: 'node24' },
      });
      const request = {
        repositoryId: 'repo-a',
        task: 'Next task',
        source: {
          podId: 'source',
          digest: parent.config.digest,
          configuration: 'original' as const,
        },
        requestId: 'follow-up',
      };
      const original = await admitLaunch({
        request,
        actorId: 'user',
        services,
        snapshots,
        createPod: () => insertConfigurationTestPod(db, 'original-child'),
      });
      expect(original.config.environment.template).toBe('node22');
      expect(original.config.task).toBe('Next task');
      expect(original.config.derivation?.kind).toBe('follow-up');
      await expect(
        admitLaunch({
          request: {
            ...request,
            requestId: 'forged',
            overrides: { workflow: { completion: 'merge' } },
          },
          actorId: 'user',
          services,
          snapshots,
          createPod: vi.fn(),
        }),
      ).rejects.toMatchObject({ code: 'FROZEN_CONFIGURATION_EDIT' });
      const currentRequest = {
        ...request,
        requestId: 'current',
        source: { ...request.source, configuration: 'current' as const },
      };
      const { resolveLaunch } = await import('./launch-resolver.js');
      const preview = await resolveLaunch(currentRequest, services);
      const current = await admitLaunch({
        request: { ...currentRequest, expectedDigest: preview.digest },
        actorId: 'user',
        services,
        snapshots,
        createPod: () => insertConfigurationTestPod(db, 'current-child'),
      });
      expect(current.config.environment.template).toBe('node24');
      expect(current.config.derivation).toBeUndefined();
      expect(current.config.origin).toEqual({ kind: 'follow-up', ...currentRequest.source });
      vi.mocked(services.resolveEnvironment).mockRejectedValue(new Error('Unavailable'));
      expect(
        (await admitLaunch({ request, actorId: 'user', services, snapshots, createPod: vi.fn() }))
          .podId,
      ).toBe(original.podId);
    } finally {
      db.close();
    }
  });
  it('derives fix authority from the frozen parent after preset edits and refuses forged scope changes', async () => {
    const db = createTestDb();
    try {
      const { store, services } = createTestConfiguration(db);
      const snapshots = createLaunchSnapshotRepository(db, store);
      const parent = await admitLaunch({
        request: { repositoryId: 'repo-a', task: 'Original task' },
        actorId: 'user',
        services,
        snapshots,
        createPod: () => insertConfigurationTestPod(db, 'parent'),
      });
      const env = store.get('environment', 'env');
      store.write({
        ...env,
        expectedRevision: env.revision,
        payload: { ...env.payload, template: 'node24' },
      });
      const config = deriveLaunch(parent.config, {
        source: { podId: parent.podId, digest: parent.config.digest, kind: 'fix' },
        task: 'Fix failed check',
        work: { linkedPodId: parent.podId },
      });
      const inserted = snapshots.admit({
        config,
        requestId: 'fix-parent',
        requestDigest: config.digest,
        createPod: () => insertConfigurationTestPod(db, 'child'),
      });
      expect(snapshots.get(inserted.podId)?.environment.template).toBe('node22');
      expect(snapshots.get(inserted.podId)?.derivation?.digest).toBe(parent.config.digest);
      const { digest: _, ...body } = config;
      const widened = {
        ...body,
        githubAccess: [{ ...parent.config.githubAccess[0]!, repositoryIds: ['repo-a', 'repo-b'] }],
      };
      expect(() =>
        snapshots.admit({
          config: { ...widened, digest: configurationDigest(widened) },
          requestDigest: 'forged',
          createPod: () => insertConfigurationTestPod(db, 'forged'),
        }),
      ).toThrow('widened');
      expect(db.prepare("SELECT 1 FROM pods WHERE id='forged'").get()).toBeUndefined();
      expect(() =>
        deriveLaunch(parent.config, {
          source: { podId: parent.podId, digest: parent.config.digest, kind: 'worker' },
          task: 'Worker',
        }),
      ).toThrow('requires an interactive launch');
    } finally {
      db.close();
    }
  });
  it('awaits resource preflight before inserting a new launch, without rechecking replay', async () => {
    const db = createTestDb();
    try {
      const { store, services } = createTestConfiguration(db);
      const snapshots = createLaunchSnapshotRepository(db, store);
      const createPod = vi.fn(() => insertConfigurationTestPod(db, 'preflight-child'));
      const assertResolved = vi
        .fn(async () => {})
        .mockRejectedValueOnce(new Error('Only one subnet'));
      const input = {
        request: { repositoryId: 'repo-a', task: 'Prepared', requestId: 'capacity-launch' },
        actorId: 'user',
        services,
        snapshots,
        createPod,
        assertResolved,
      };
      await expect(admitLaunch(input)).rejects.toThrow('Only one subnet');
      expect(createPod).not.toHaveBeenCalled();
      expect(db.prepare('SELECT count(*) FROM pod_launch_snapshots').pluck().get()).toBe(0);
      const first = await admitLaunch(input);
      assertResolved.mockRejectedValue(new Error('Capacity changed'));
      expect(await admitLaunch(input)).toEqual({ ...first, created: false });
      expect(assertResolved).toHaveBeenCalledTimes(2);
      expect(createPod).toHaveBeenCalledOnce();
    } finally {
      db.close();
    }
  });

  it('runs async insertion preflight once and skips it on exact saved replay', async () => {
    const db = createTestDb();
    try {
      const { store, services } = createTestConfiguration(db);
      const snapshots = createLaunchSnapshotRepository(db, store);
      const insert = vi.fn(() => insertConfigurationTestPod(db, 'prepared-child'));
      const preparePod = vi.fn(async () => insert);
      const fallback = vi.fn(() => 'must-not-run');
      const input = {
        request: { repositoryId: 'repo-a', task: 'Prepared', requestId: 'prepared-launch' },
        actorId: 'user',
        services,
        snapshots,
        createPod: fallback,
        preparePod,
      };
      const first = await admitLaunch(input);
      preparePod.mockRejectedValue(new Error('Resource is now unavailable'));
      expect(await admitLaunch(input)).toEqual({ ...first, created: false });
      expect(preparePod).toHaveBeenCalledTimes(1);
      expect(insert).toHaveBeenCalledTimes(1);
      expect(fallback).not.toHaveBeenCalled();
    } finally {
      db.close();
    }
  });

  it('returns the original snapshot before consulting edited presets and rejects changed requests or actors', async () => {
    const db = createTestDb();
    try {
      const { store, services } = createTestConfiguration(db);
      const snapshots = createLaunchSnapshotRepository(db, store);
      const input = {
        request: { repositoryId: 'repo-a', task: 'Fix', requestId: 'operation' },
        actorId: 'user',
        services,
        snapshots,
        createPod: vi.fn(() => insertConfigurationTestPod(db, 'pod-one')),
      };
      const first = await admitLaunch(input);
      expect(first.created).toBe(true);
      const env = store.get('environment', 'env');
      store.write({
        ...env,
        expectedRevision: env.revision,
        payload: { ...env.payload, template: 'node24' },
      });
      vi.mocked(services.executionCapabilities).mockRejectedValue(new Error('Backend offline'));
      const replay = await admitLaunch(input);
      expect(replay).toEqual({ ...first, created: false });
      expect(replay.config.environment.template).toBe('node22');
      expect(input.createPod).toHaveBeenCalledTimes(1);
      expect(services.executionCapabilities).toHaveBeenCalledTimes(1);
      await expect(
        admitLaunch({ ...input, request: { ...input.request, task: 'Different' } }),
      ).rejects.toThrow('different payload');
      await expect(admitLaunch({ ...input, actorId: 'different-user' })).rejects.toThrow(
        'different payload',
      );
      await expect(
        admitLaunch({ ...input, request: { ...input.request, requestId: 'new-operation' } }),
      ).rejects.toThrow('Backend offline');
      const archive = createTaskHistoryArchive(db);
      db.transaction(() => {
        archive(first.podId);
        db.prepare('DELETE FROM pods WHERE id=?').run(first.podId);
      })();
      expect(snapshots.get(first.podId)).toEqual(first.config);
      expect(await admitLaunch(input)).toEqual({ ...first, created: false });
      expect(input.createPod).toHaveBeenCalledTimes(1);
      expect(() => db.prepare('DELETE FROM task_history_pod_launch_snapshots').run()).toThrow(
        'immutable',
      );
    } finally {
      db.close();
    }
  });
});
