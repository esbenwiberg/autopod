import { describe, expect, it, vi } from 'vitest';
import { createActionAuditRepository } from '../actions/audit-repository.js';
import { createPodManager } from '../pods/pod-manager.js';
import { createTaskHistoryArchive } from '../pods/task-history-archive.js';
import { createProviderAccountStore } from '../provider-accounts/provider-account-store.js';
import {
  createTestConfiguration,
  insertConfigurationTestPod,
} from '../test-utils/configuration-helpers.js';
import { createTestContext, createTestDb } from '../test-utils/mock-helpers.js';
import { createConfigurationComponents } from './components.js';
import { configurationDigest } from './configuration-digest.js';
import { createConfigurationCredentialStore } from './credential-store.js';
import { deriveLaunch } from './derive-launch.js';
import { admitLaunch } from './launch-admission.js';
import { createLaunchSnapshotRepository } from './launch-snapshot.js';

describe('frozen workspace handoff', () => {
  it.each(['stopped', 'unknown'] as const)(
    'switches the worker account only after %s workspace termination',
    async (termination) => {
      const ctx = createTestContext();
      try {
        const { store, services } = createTestConfiguration(ctx.db);
        const accounts = createProviderAccountStore(ctx.db);
        accounts.create({
          id: 'account',
          name: 'Interactive account',
          provider: 'anthropic',
          credentials: { provider: 'anthropic', apiKey: 'fixture-main' },
        });
        accounts.create({
          id: 'worker-account',
          name: 'Worker account',
          provider: 'openai',
          credentials: {
            provider: 'openai',
            authJson: JSON.stringify({ OPENAI_API_KEY: 'fixture-worker' }),
          },
        });
        store.writeBatch([
          {
            kind: 'workflow',
            id: 'interactive',
            name: 'Interactive',
            payload: {
              agentMode: 'interactive',
              output: 'branch',
              promotable: true,
              validationPhases: [],
            },
          },
          {
            kind: 'workflow',
            id: 'worker-flow',
            name: 'Worker flow',
            payload: { validationPhases: [], output: 'artifact' },
          },
          {
            kind: 'ai',
            id: 'worker-ai',
            name: 'Worker AI',
            payload: {
              main: { providerAccountId: 'worker-account', runtime: 'codex', model: 'gpt-5' },
            },
          },
          {
            kind: 'profile',
            id: 'worker',
            name: 'Worker',
            payload: { environmentId: 'env', aiId: 'worker-ai', workflowId: 'worker-flow' },
          },
          {
            kind: 'profile',
            id: 'workspace',
            name: 'Workspace',
            payload: {
              environmentId: 'env',
              aiId: 'ai',
              workflowId: 'interactive',
              workerProfileId: 'worker',
            },
          },
        ]);
        const components = createConfigurationComponents({
          db: ctx.db,
          logger: ctx.deps.logger,
          pods: ctx.podRepo,
          accounts,
          credentials: createConfigurationCredentialStore(
            ctx.db,
            { encrypt: (s) => s, decrypt: (s) => s },
            async () => {},
          ),
          images: {
            resolveEnvironment: services.resolveEnvironment,
            buildEnvironmentImage: vi.fn(async () => {
              throw new Error('Fixture stops after worker activation');
            }),
          },
          github: { get: vi.fn(), mutate: vi.fn(), download: vi.fn() },
          audit: createActionAuditRepository(ctx.db),
          pim: {
            eligibility: { discover: vi.fn(), selected: vi.fn() },
            provider: { existing: vi.fn(), submit: vi.fn(), reconcile: vi.fn() },
          },
          reviewer: {
            manager: () => ctx.containerManager,
            image: () => `trusted@sha256:${'a'.repeat(64)}`,
          },
          ports: services,
          admissionReady: () => ({ ready: true }),
          podManager: () => manager,
        });
        const manager: ReturnType<typeof createPodManager> = createPodManager({
          ...ctx.deps,
          providerAccountStore: accounts,
          launchConfiguration: components.launchConfiguration,
        });
        const admitted = await components.routes.admit!(
          { repositoryId: 'repo-a', profileId: 'workspace', task: 'Finish work' },
          { userId: 'user', actor: { type: 'human', userId: 'user' } },
        );
        ctx.podRepo.update(admitted.id, {
          status: 'running',
          containerId: 'interactive-container',
          worktreePath: '/tmp/worktree/fixture-worker-handoff',
        });
        const original = components.snapshots.get(admitted.id);
        const workerAi = store.get('ai', 'worker-ai');
        store.write({
          ...workerAi,
          expectedRevision: workerAi.revision,
          payload: {
            main: { providerAccountId: 'account', runtime: 'claude', model: 'claude-sonnet-4-6' },
          },
        });
        await manager.promoteToAuto(admitted.id, 'artifact', { instructions: 'Finish the tests' });
        expect(components.snapshots.get(admitted.id)).toEqual(original);
        vi.mocked(ctx.containerManager.stop).mockImplementation(async () => {
          expect(ctx.podRepo.getOrThrow(admitted.id).providerAccountIdSnapshot).toBe('account');
          expect(components.snapshots.get(admitted.id)?.digest).toBe(original?.digest);
        });
        vi.mocked(ctx.containerManager.getStatus).mockResolvedValue(termination);
        await manager.processPod(admitted.id);
        const current = ctx.podRepo.getOrThrow(admitted.id);
        expect(ctx.containerManager.stop).toHaveBeenCalledWith('interactive-container');
        if (termination === 'unknown') {
          expect(current.providerAccountIdSnapshot).toBe('account');
          expect(components.snapshots.get(admitted.id)).toEqual(original);
          expect(current.lastCorrectionMessage).toContain('termination');
        } else {
          expect(current.providerAccountIdSnapshot).toBe('worker-account');
          expect(current.runtime).toBe('codex');
          expect(components.snapshots.get(admitted.id)?.profileId).toBe('worker');
          expect(components.snapshots.getOriginal(admitted.id)).toEqual(original);
        }
      } finally {
        ctx.db.close();
      }
    },
  );
  it('keeps original authority until workspace cleanup and retains both phases through archive', async () => {
    const db = createTestDb();
    try {
      const { store, services } = createTestConfiguration(db);
      store.write({
        kind: 'workflow',
        id: 'interactive',
        name: 'Interactive',
        payload: {
          agentMode: 'interactive',
          output: 'branch',
          promotable: true,
          validationPhases: [],
        },
      });
      store.write({
        kind: 'profile',
        id: 'workspace',
        name: 'Workspace',
        payload: {
          environmentId: 'env',
          aiId: 'ai',
          workflowId: 'interactive',
          workerProfileId: 'profile',
        },
      });
      const snapshots = createLaunchSnapshotRepository(db, store);
      const admitted = await admitLaunch({
        request: { repositoryId: 'repo-a', profileId: 'workspace', task: 'Build' },
        actorId: 'user',
        services,
        snapshots,
        createPod: () => insertConfigurationTestPod(db, 'workspace'),
      });
      db.prepare(
        "UPDATE pods SET status='running',container_id='interactive' WHERE id='workspace'",
      ).run();
      const original = admitted.config;
      const env = store.get('environment', 'env');
      store.write({
        ...env,
        expectedRevision: env.revision,
        payload: { ...env.payload, template: 'node24' },
      });
      const worker = deriveLaunch(original, {
        source: { kind: 'worker', podId: 'workspace', digest: original.digest },
        task: 'Build',
        output: 'artifact',
        work: { handoffInstructions: 'Finish the tests' },
      });
      const handoff = () =>
        db.prepare("UPDATE pods SET status='handoff' WHERE id='workspace'").run();
      snapshots.prepareWorker({ config: worker, expectedGeneration: 1, apply: handoff });
      expect(snapshots.get('workspace')).toEqual(original);
      expect(snapshots.getPendingWorker('workspace')?.environment.template).toBe('node22');
      expect(() => snapshots.activateWorker('workspace', 1, () => {})).toThrow('not ready');
      db.prepare("UPDATE pods SET container_id=NULL WHERE id='workspace'").run();
      expect(() => snapshots.activateWorker('workspace', 2, () => {})).toThrow('not ready');
      expect(() =>
        snapshots.activateWorker('workspace', 1, () => {
          throw new Error('Binding failed');
        }),
      ).toThrow('Binding failed');
      expect(snapshots.get('workspace')).toEqual(original);
      expect(snapshots.activateWorker('workspace', 1, () => {})).toBe(true);
      expect(snapshots.get('workspace')).toEqual(worker);
      expect(snapshots.get('workspace')?.workflow.output).toBe('artifact');
      expect(snapshots.getOriginal('workspace')).toEqual(original);
      expect(snapshots.activateWorker('workspace', 1, () => {})).toBe(false);
      db.prepare("UPDATE pods SET status='complete' WHERE id='workspace'").run();
      const archive = createTaskHistoryArchive(db);
      db.transaction(() => {
        archive('workspace');
        db.prepare("DELETE FROM pods WHERE id='workspace'").run();
      })();
      const reopened = createLaunchSnapshotRepository(db, store);
      expect(reopened.get('workspace')).toEqual(worker);
      expect(reopened.getOriginal('workspace')).toEqual(original);
      expect(() => db.prepare('DELETE FROM pod_launch_phases').run()).toThrow('immutable');
    } finally {
      db.close();
    }
  });
  it('rejects forged worker access and rolls back a failed handoff transition', async () => {
    const db = createTestDb();
    try {
      const { store, services } = createTestConfiguration(db);
      const snapshots = createLaunchSnapshotRepository(db, store);
      const admitted = await admitLaunch({
        request: {
          repositoryId: 'repo-a',
          task: 'Work',
          overrides: { workflow: { agentMode: 'interactive', promotable: true } },
        },
        actorId: 'user',
        services,
        snapshots,
        createPod: () => insertConfigurationTestPod(db, 'w'),
      });
      db.prepare("UPDATE pods SET status='running' WHERE id='w'").run();
      const worker = deriveLaunch(admitted.config, {
        source: { kind: 'worker', podId: 'w', digest: admitted.config.digest },
        task: 'Finish',
      });
      const { digest: _, ...body } = worker;
      const changed = { ...body, pim: [{ roleId: 'forged' }] };
      expect(() =>
        snapshots.prepareWorker({
          config: { ...worker, ...changed, digest: configurationDigest(changed) } as typeof worker,
          expectedGeneration: 1,
          apply: () => {},
        }),
      ).toThrow('widened');
      expect(() =>
        snapshots.prepareWorker({
          config: worker,
          expectedGeneration: 1,
          apply: () => {
            throw new Error('Transition failed');
          },
        }),
      ).toThrow('Transition failed');
      expect(snapshots.getPendingWorker('w')).toBeNull();
      expect(snapshots.get('w')).toEqual(admitted.config);
    } finally {
      db.close();
    }
  });
});
