import { describe, expect, it, vi } from 'vitest';
import { resolveLaunch } from '../configuration/launch-resolver.js';
import { createLaunchSnapshotRepository } from '../configuration/launch-snapshot.js';
import { createTestConfiguration } from '../test-utils/configuration-helpers.js';
import { createTestContext } from '../test-utils/mock-helpers.js';
import { admitComposablePod } from './composable-pod-admission.js';

describe('direct composed pod admission', () => {
  it('admits empty research workspaces without looking up a legacy repository profile', async () => {
    const ctx = createTestContext();
    try {
      const { services, store } = createTestConfiguration(ctx.db);
      const snapshots = createLaunchSnapshotRepository(ctx.db, store);
      const config = await resolveLaunch(
        {
          emptyWorkspace: true,
          profileId: 'profile',
          task: 'Research web sources without a destination repository',
          overrides: { workflow: { output: 'artifact', validationPhases: [] } },
        },
        services,
      );
      const admitted = snapshots.admit({
        config,
        requestDigest: config.digest,
        createPod: () =>
          admitComposablePod({
            config,
            userId: 'owner',
            pods: ctx.podRepo,
            read: snapshots.get,
            events: ctx.deps.eventBus,
            enqueue: vi.fn(),
          }).id,
      });
      expect(ctx.podRepo.getOrThrow(admitted.podId).options.output).toBe('artifact');
      expect(snapshots.get(admitted.podId)?.repository).toBeNull();
      expect(ctx.db.prepare('SELECT * FROM execution_dispatch_bindings').all()).toHaveLength(0);
      expect(ctx.profileStore.get).not.toHaveBeenCalled();
      const repositoryConfig = await resolveLaunch(
        { repositoryId: 'repo-a', task: config.task },
        services,
      );
      const repositoryPod = snapshots.admit({
        config: repositoryConfig,
        requestDigest: repositoryConfig.digest,
        createPod: () =>
          admitComposablePod({
            config: repositoryConfig,
            userId: 'owner',
            pods: ctx.podRepo,
            read: snapshots.get,
            events: ctx.deps.eventBus,
            enqueue: vi.fn(),
          }).id,
      });
      if (!repositoryConfig.repository) throw new Error('Missing repository fixture');
      expect(
        ctx.podRepo.dispatchPreflight?.inspect(
          repositoryPod.podId,
          1,
          repositoryConfig.repository.config.remote,
          'main',
          'a'.repeat(40),
        ).status,
      ).toBe('admitted');
    } finally {
      ctx.db.close();
    }
  });

  it('publishes only after snapshot commit and preserves task-specific context without a legacy profile', async () => {
    const ctx = createTestContext();
    try {
      const { services, store } = createTestConfiguration(ctx.db);
      const snapshots = createLaunchSnapshotRepository(ctx.db, store);
      const config = await resolveLaunch(
        {
          repositoryId: 'repo-a',
          task: 'Keep the contract',
          work: {
            branch: 'custom/work',
            baseBranch: 'release',
            startBranch: 'release-seed',
            handoffInstructions: 'Retain this instruction',
            touches: ['src/a.ts'],
            doesNotTouch: ['src/b.ts'],
            specContextFiles: [{ path: 'design.md', content: 'Context' }],
          },
        },
        services,
      );
      const enqueue = vi.fn((id: string) => {
        expect(snapshots.get(id)?.digest).toBe(config.digest);
      });
      const admitted = snapshots.admit({
        config,
        requestDigest: config.digest,
        createPod: () => {
          const pod = admitComposablePod({
            config,
            userId: 'owner',
            pods: ctx.podRepo,
            read: snapshots.get,
            events: ctx.deps.eventBus,
            enqueue,
          });
          expect(enqueue).not.toHaveBeenCalled();
          expect(pod.profileSnapshot).toBeNull();
          return pod.id;
        },
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(enqueue).toHaveBeenCalledExactlyOnceWith(admitted.podId);
      expect(ctx.podRepo.getOrThrow(admitted.podId)).toMatchObject({
        branch: 'custom/work',
        baseBranch: 'release',
        startBranch: 'release-seed',
        handoffInstructions: 'Retain this instruction',
        touches: ['src/a.ts'],
        doesNotTouch: ['src/b.ts'],
        specContextFiles: [{ path: 'design.md', content: 'Context' }],
      });
      expect(ctx.profileStore.get).not.toHaveBeenCalled();
    } finally {
      ctx.db.close();
    }
  });
  it('refuses cross-repository dependency admission without inserting or enqueuing a child', async () => {
    const ctx = createTestContext();
    try {
      const { services, store } = createTestConfiguration(ctx.db);
      const snapshots = createLaunchSnapshotRepository(ctx.db, store);
      const enqueue = vi.fn();
      const parent = await resolveLaunch({ repositoryId: 'repo-a', task: 'Parent' }, services);
      const create = (config: typeof parent) =>
        admitComposablePod({
          config,
          userId: 'owner',
          pods: ctx.podRepo,
          read: snapshots.get,
          events: ctx.deps.eventBus,
          enqueue,
        }).id;
      const saved = snapshots.admit({
        config: parent,
        requestDigest: parent.digest,
        createPod: () => create(parent),
      });
      const child = await resolveLaunch(
        { repositoryId: 'repo-b', task: 'Child', work: { dependsOnPodIds: [saved.podId] } },
        services,
      );
      expect(() =>
        snapshots.admit({
          config: child,
          requestDigest: child.digest,
          createPod: () => create(child),
        }),
      ).toThrow('Dependent pods must use the same enrolled repository');
      expect(ctx.podRepo.listNonTerminal()).toHaveLength(1);
    } finally {
      ctx.db.close();
    }
  });
});
