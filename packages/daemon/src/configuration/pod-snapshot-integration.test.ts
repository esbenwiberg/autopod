import { describe, expect, it, vi } from 'vitest';
import { createPodGoalService } from '../pods/pod-goal-service.js';
import { createPodManager } from '../pods/pod-manager.js';
import { createProviderAccountStore } from '../provider-accounts/provider-account-store.js';
import { createTestConfiguration } from '../test-utils/configuration-helpers.js';
import { createTestContext } from '../test-utils/mock-helpers.js';
import { resolveLaunchAgentRoute } from './agent-route-resolution.js';
import { admitLaunch } from './launch-admission.js';
import { resolveLaunchExecutionSettings } from './launch-execution-settings.js';
import { createLaunchSnapshotRepository } from './launch-snapshot.js';

describe('pod manager launch snapshot integration', () => {
  it('admits Goal state with the snapshot atomically and refuses ordinary completion or execution', async () => {
    const ctx = createTestContext();
    try {
      const { services, store } = createTestConfiguration(ctx.db);
      const accounts = createProviderAccountStore(ctx.db);
      accounts.create({
        id: 'account',
        name: 'Main',
        provider: 'openai',
        credentials: {
          provider: 'openai',
          authJson: JSON.stringify({ OPENAI_API_KEY: 'fixture' }),
        },
      });
      services.resolveAgentRoute = async (route) => resolveLaunchAgentRoute(route, accounts);
      store.write({
        kind: 'ai',
        id: 'ai',
        name: 'AI',
        expectedRevision: 1,
        payload: { main: { providerAccountId: 'account', runtime: 'codex', model: 'gpt-5' } },
      });
      const snapshots = createLaunchSnapshotRepository(ctx.db, store);
      const goals = createPodGoalService({
        db: ctx.db,
        pods: ctx.podRepo,
        evidence: [],
        assertAllowed: async () => {},
        assertCurrent: () => {},
        publish: () => {},
      });
      const enqueueSession = vi.fn();
      const manager = createPodManager({
        ...ctx.deps,
        enqueueSession,
        providerAccountStore: accounts,
        launchConfiguration: {
          goals,
          read: snapshots.get,
          executionSettings: (config) =>
            resolveLaunchExecutionSettings(config, { image: `sha256:${'a'.repeat(64)}` }),
          assertCurrentCapabilities: async () => {},
          prepareEnvironment: async () => 'fixture',
        },
      });
      const create = manager.createResolvedSession?.bind(manager);
      if (!create) throw new Error('Missing fixture admission');
      const admit = () =>
        admitLaunch({
          request: { repositoryId: 'repo-a', task: 'Tests pass', intent: 'goal' },
          actorId: 'user',
          services,
          snapshots,
          createPod: (config) => create(config, 'user').id,
        });
      const admitted = await admit();
      expect(goals.get(admitted.podId)).toMatchObject({
        objective: 'Tests pass',
        state: 'active',
        executionStopped: true,
      });
      const dispatched = vi.fn();
      const ordinary = (async function* () {
        dispatched();
        yield { type: 'complete' as const, timestamp: 'now', result: 'Done' };
      })();
      await expect(manager.consumeAgentEvents(admitted.podId, ordinary)).rejects.toMatchObject({
        code: 'GOAL_NATIVE_RESUME_REQUIRED',
      });
      expect(dispatched).not.toHaveBeenCalled();
      await expect(manager.handleCompletion(admitted.podId)).rejects.toMatchObject({
        code: 'GOAL_NOT_ACHIEVED',
      });
      await expect(manager.triggerValidation(admitted.podId)).rejects.toMatchObject({
        code: 'GOAL_NOT_ACHIEVED',
      });
      const before = ctx.db.prepare('SELECT id FROM pods ORDER BY id').all();
      ctx.db.exec(
        "CREATE TRIGGER reject_goal BEFORE INSERT ON pod_goals BEGIN SELECT RAISE(ABORT, 'fixture goal rejection'); END",
      );
      await expect(admit()).rejects.toThrow('fixture goal rejection');
      expect(ctx.db.prepare('SELECT id FROM pods ORDER BY id').all()).toEqual(before);
      expect(ctx.db.prepare('SELECT COUNT(*) AS count FROM pod_launch_snapshots').get()).toEqual({
        count: 1,
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(enqueueSession).toHaveBeenCalledOnce();
    } finally {
      ctx.db.close();
    }
  });
  it.each(['anthropic', 'openai'] as const)(
    'binds a reviewer independently from a %s main account',
    async (mainProvider) => {
      const ctx = createTestContext();
      try {
        const { services, store } = createTestConfiguration(ctx.db);
        const accounts = createProviderAccountStore(ctx.db);
        const reviewerProvider = mainProvider === 'anthropic' ? 'openai' : 'anthropic';
        for (const [id, provider] of [
          ['account', mainProvider],
          ['reviewer-account', reviewerProvider],
        ] as const) {
          accounts.create({
            id,
            name: id,
            provider,
            credentials:
              provider === 'anthropic'
                ? { provider, apiKey: 'fixture-key' }
                : { provider, authJson: JSON.stringify({ OPENAI_API_KEY: 'fixture-key' }) },
          });
        }
        services.resolveAgentRoute = async (route) => resolveLaunchAgentRoute(route, accounts);
        const route = (provider: typeof mainProvider, providerAccountId: string) => ({
          providerAccountId,
          runtime: provider === 'anthropic' ? 'claude' : 'codex',
          model: provider === 'anthropic' ? 'claude-sonnet-4-6' : 'gpt-5',
        });
        store.write({
          kind: 'ai',
          id: 'ai',
          name: 'Main AI',
          expectedRevision: 1,
          payload: {
            main: route(mainProvider, 'account'),
            reviewer: { mode: 'independent', route: route(reviewerProvider, 'reviewer-account') },
          },
        });
        const snapshots = createLaunchSnapshotRepository(ctx.db, store);
        const manager = createPodManager({
          ...ctx.deps,
          providerAccountStore: accounts,
          launchConfiguration: {
            read: snapshots.get,
            executionSettings: (config) =>
              resolveLaunchExecutionSettings(config, { image: `sha256:${'a'.repeat(64)}` }),
            assertCurrentCapabilities: async () => {},
            prepareEnvironment: async () => `sha256:${'a'.repeat(64)}`,
          },
        });
        const launch = await admitLaunch({
          request: { repositoryId: 'repo-a', task: 'Fix' },
          actorId: 'user',
          services,
          snapshots,
          createPod: (config) => {
            if (!manager.createResolvedSession) throw new Error('Expected composable admission');
            return manager.createResolvedSession(config, 'user').id;
          },
        });
        const pod = ctx.podRepo.getOrThrow(launch.podId);
        expect(manager.getReviewerConfig(pod).profile).toMatchObject({
          modelProvider: reviewerProvider,
          providerAccountId: 'reviewer-account',
          defaultRuntime: route(reviewerProvider, '').runtime,
        });
        // Main account revocation must not redirect the independent reviewer to another account.
        accounts.updateCredentials('account', null);
        expect(manager.getReviewerConfig(pod).profile.providerAccountId).toBe('reviewer-account');
        accounts.updateCredentials('reviewer-account', null);
        expect(() => manager.getReviewerConfig(pod)).toThrow('not authenticated');
      } finally {
        ctx.db.close();
      }
    },
  );
  it('creates queued pods from one shared profile and reads their snapshots after edits, archive and manager restart', async () => {
    const ctx = createTestContext();
    try {
      const { services, store } = createTestConfiguration(ctx.db);
      const accounts = createProviderAccountStore(ctx.db);
      accounts.create({
        id: 'account',
        name: 'Main account',
        provider: 'anthropic',
        credentials: { provider: 'anthropic', apiKey: 'fixture-key' },
      });
      services.resolveAgentRoute = async (route) => resolveLaunchAgentRoute(route, accounts);
      const snapshots = createLaunchSnapshotRepository(ctx.db, store);
      const project = vi.fn((config: Parameters<typeof resolveLaunchExecutionSettings>[0]) =>
        resolveLaunchExecutionSettings(config, { image: `image@sha256:${'a'.repeat(64)}` }),
      );
      const deps = {
        ...ctx.deps,
        providerAccountStore: accounts,
        launchConfiguration: {
          read: snapshots.get,
          executionSettings: project,
          assertCurrentCapabilities: async () => {},
          prepareEnvironment: async () => `sha256:${'a'.repeat(64)}`,
        },
      };
      const manager = createPodManager(deps);
      vi.mocked(ctx.profileStore.get).mockImplementation(() => {
        throw new Error('Unexpected mutable legacy-profile read');
      });
      const create = async (repositoryId: string, requestId: string) =>
        admitLaunch({
          request: { repositoryId, task: 'Fix', requestId },
          actorId: 'user',
          services,
          snapshots,
          createPod: (config) => {
            if (!manager.createResolvedSession) throw new Error('Missing resolved creation');
            return manager.createResolvedSession(config, 'user').id;
          },
        });
      const a = await create('repo-a', 'one');
      const b = await create('repo-b', 'two');
      expect(ctx.podRepo.getOrThrow(a.podId).launchConfigDigest).toBe(a.config.digest);
      expect(project).not.toHaveBeenCalled();
      expect(ctx.podRepo.getOrThrow(b.podId).profileSnapshot).toBeNull();
      expect(snapshots.get(b.podId)?.repository?.config.remote).toBe(
        'https://github.com/org/repo-b',
      );
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(ctx.enqueuedSessions).toEqual([a.podId, b.podId]);
      const env = store.get('environment', 'env');
      store.write({
        ...env,
        expectedRevision: env.revision,
        payload: { ...env.payload, template: 'node24' },
      });
      store.archive('repository', 'repo-a', 1);
      store.archive('repository', 'repo-b', 1);
      store.archive('profile', 'profile', 1);
      store.archive('environment', 'env', 2);
      const restarted = createPodManager({
        ...deps,
        launchConfiguration: {
          ...deps.launchConfiguration,
          read: createLaunchSnapshotRepository(ctx.db, store).get,
        },
      });
      expect(restarted.getReviewerConfig(ctx.podRepo.getOrThrow(a.podId)).profile.template).toBe(
        'node22',
      );
      expect(restarted.getReviewerConfig(ctx.podRepo.getOrThrow(a.podId)).profile.repoUrl).toBe(
        'https://github.com/org/repo-a',
      );
      expect((await create('repo-a', 'one')).created).toBe(false);
      expect(ctx.profileStore.get).not.toHaveBeenCalled();
      accounts.updateCredentials('account', null);
      expect(() => restarted.getReviewerConfig(ctx.podRepo.getOrThrow(a.podId))).toThrow(
        'not authenticated',
      );
      ctx.db.prepare('DELETE FROM pod_launch_snapshots WHERE pod_id=?').run(b.podId);
      expect(() => restarted.getReviewerConfig(ctx.podRepo.getOrThrow(b.podId))).toThrow(
        'integrity',
      );
    } finally {
      ctx.db.close();
    }
  });
});
