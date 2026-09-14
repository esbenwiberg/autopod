import { describe, expect, it, vi } from 'vitest';
import { createActionAuditRepository } from '../actions/audit-repository.js';
import { createPimEligibilityService } from '../pim/eligibility-service.js';
import { createPodManager } from '../pods/pod-manager.js';
import { createProviderAccountStore } from '../provider-accounts/provider-account-store.js';
import { createScheduledJobManager } from '../scheduled-jobs/scheduled-job-manager.js';
import { createScheduledJobRepository } from '../scheduled-jobs/scheduled-job-repository.js';
import { createScheduledJobTemplateRepository } from '../scheduled-jobs/scheduled-job-template-repository.js';
import { createTestConfiguration } from '../test-utils/configuration-helpers.js';
import { createTestContext } from '../test-utils/mock-helpers.js';
import { createConfigurationComponents } from './components.js';
import { createConfigurationCredentialStore } from './credential-store.js';
import { resolveLaunch } from './launch-resolver.js';

describe('composable daemon services', () => {
  it('shares read-only preview, frozen admission, execution credentials and operator revocation without a legacy profile anchor', async () => {
    const ctx = createTestContext();
    try {
      const fixture = createTestConfiguration(ctx.db);
      const accounts = createProviderAccountStore(ctx.db);
      accounts.create({
        id: 'account',
        name: 'Main',
        provider: 'anthropic',
        credentials: { provider: 'anthropic', apiKey: 'fixture-key' },
      });
      const credentials = createConfigurationCredentialStore(
        ctx.db,
        { encrypt: (s) => `fixture:${s}`, decrypt: (s) => s.slice(8) },
        async () => {},
      );
      await credentials.create({
        id: 'service',
        name: 'Fixture service',
        purposes: ['build-env', 'registry-read'],
        origins: ['https://registry.example.test'],
        value: 'first-fixture-value',
      });
      const repository = fixture.store.get('repository', 'repo-a');
      fixture.store.write({
        ...repository,
        expectedRevision: repository.revision,
        payload: {
          ...repository.payload,
          setups: repository.payload.setups.map((setup) => ({
            ...setup,
            buildEnv: { SERVICE_TOKEN: { secretId: 'service' } },
            integrations: {
              ...setup.integrations,
              privateRegistries: [
                {
                  type: 'npm',
                  url: 'https://registry.example.test',
                  scope: '@fixture',
                  credential: { secretId: 'service' },
                },
              ],
            },
          })),
        },
      });
      const provider = { existing: vi.fn(), submit: vi.fn(), reconcile: vi.fn() };
      const eligibility = createPimEligibilityService(
        { account: { tenantId: 'tenant', principalId: 'user' }, get: vi.fn(), mutate: vi.fn() },
        { maximumDurationMinutes: vi.fn() },
      );
      const build = vi.fn(async () => ({
        tag: `sha256:${'c'.repeat(64)}`,
        digest: `sha256:${'c'.repeat(64)}`,
        size: 1,
        buildDuration: 0,
      }));
      let ready = false;
      const components = createConfigurationComponents({
        db: ctx.db,
        logger: ctx.deps.logger,
        pods: ctx.podRepo,
        accounts,
        credentials,
        images: {
          resolveEnvironment: fixture.services.resolveEnvironment,
          buildEnvironmentImage: build,
        },
        github: { get: vi.fn(), mutate: vi.fn(), download: vi.fn() },
        audit: createActionAuditRepository(ctx.db),
        pim: { eligibility, provider },
        reviewer: {
          manager: () => ctx.containerManager,
          image: () => `trusted/reviewer@sha256:${'a'.repeat(64)}`,
        },
        ports: fixture.services,
        admissionReady: () => ({ ready, reason: ready ? undefined : 'Explicit cutover required' }),
        podManager: () => manager,
      });
      const manager: ReturnType<typeof createPodManager> = createPodManager({
        ...ctx.deps,
        providerAccountStore: accounts,
        launchConfiguration: components.launchConfiguration,
      });
      const work = {
        handoffInstructions: 'Use this approved plan',
        specContextFiles: [{ path: 'brief.md', content: 'Required checks' }],
      };
      const request = {
        repositoryId: 'repo-a',
        task: 'Implement',
        selections: { githubAccessId: null },
        work,
        requestId: 'request-one',
      };
      const identity = { userId: 'user', actor: { type: 'human' as const, userId: 'user' } };
      const preview = await resolveLaunch(request, components.resolution);
      expect(build).not.toHaveBeenCalled();
      expect(provider.submit).not.toHaveBeenCalled();
      expect(ctx.db.prepare('SELECT COUNT(*) AS n FROM pods').get()).toEqual({ n: 0 });
      const admit = components.routes.admit;
      if (!admit) throw new Error('Missing composable admission');
      await expect(admit(request, identity)).rejects.toThrow('cutover');
      ready = true;
      const pod = await admit({ ...request, expectedDigest: preview.digest }, identity);
      expect(pod.handoffInstructions).toBe(work.handoffInstructions);
      expect(pod.specContextFiles).toEqual(work.specContextFiles);
      expect(ctx.db.prepare("SELECT 1 FROM profiles WHERE name='profile'").get()).toBeUndefined();
      const saved = components.snapshots.get(pod.id);
      if (!saved) throw new Error('Missing admitted snapshot');
      expect(saved.work).toEqual(work);
      expect(JSON.stringify(saved)).not.toContain('first-fixture-value');
      ctx.podRepo.update(pod.id, { containerId: 'pod-container' });
      const validationEnvironment = manager.getValidationEnvironment;
      if (!validationEnvironment) throw new Error('Missing validation credential boundary');
      expect((await validationEnvironment(pod.id))?.SERVICE_TOKEN).toBe('first-fixture-value');
      await credentials.rotate('service', 1, 'rotated-fixture-value');
      expect((await validationEnvironment(pod.id))?.SERVICE_TOKEN).toBe('rotated-fixture-value');
      expect(ctx.containerManager.writeFile).toHaveBeenCalledWith(
        'pod-container',
        expect.stringContaining('npmrc'),
        expect.stringContaining('rotated-fixture-value'),
      );
      expect(components.snapshots.get(pod.id)?.digest).toBe(saved.digest);
      const environment = components.store.get('environment', 'env');
      components.store.write({
        ...environment,
        expectedRevision: environment.revision,
        payload: { ...environment.payload, template: 'node24' },
      });
      expect((await admit({ ...request, expectedDigest: preview.digest }, identity)).id).toBe(
        pod.id,
      );
      await components.launchConfiguration.prepareEnvironment(saved);
      expect(build).toHaveBeenCalledWith(
        expect.objectContaining({ environment: expect.objectContaining({ template: 'node22' }) }),
        { publish: false },
      );
      const schedules = createScheduledJobManager({
        scheduledJobRepo: createScheduledJobRepository(ctx.db),
        scheduledJobTemplateRepo: createScheduledJobTemplateRepository(ctx.db),
        podManager: manager,
        eventBus: ctx.deps.eventBus,
        logger: ctx.deps.logger,
        launch: components.launchScheduled,
      });
      const job = schedules.create(
        {
          name: 'Reusable repository job',
          task: 'Scheduled task',
          cronExpression: '0 9 * * *',
          launch: {
            repositoryId: 'repo-a',
            referenceRepositories: [],
            selections: { githubAccessId: null },
          },
        },
        'user',
      );
      expect(job.profileName).toBeNull();
      expect(job.ownerUserId).toBe('user');
      const scheduled = await components.launchScheduled(job, job.task, 'scheduled:one');
      expect(scheduled.scheduledJobId).toBe(job.id);
      expect(scheduled.userId).toBe('user');
      expect(components.snapshots.get(scheduled.id)?.origin).toEqual({
        kind: 'schedule',
        jobId: job.id,
        runKey: 'scheduled:one',
      });
      const newer = components.store.get('environment', 'env');
      components.store.write({
        ...newer,
        expectedRevision: newer.revision,
        payload: { ...newer.payload, template: 'node22' },
      });
      expect((await components.launchScheduled(job, job.task, 'scheduled:one')).id).toBe(
        scheduled.id,
      );
      expect(components.snapshots.get(scheduled.id)?.environment.template).toBe('node24');
      await expect(
        components.launchScheduled({ ...job, ownerUserId: 'other' }, job.task, 'scheduled:one'),
      ).rejects.toThrow();
      expect(() =>
        schedules.create(
          {
            name: 'Legacy',
            task: 'Task',
            profileName: 'test-profile',
            cronExpression: '0 9 * * *',
          },
          'user',
        ),
      ).toThrow('repository');
      const series = await components.routes.series?.create(
        {
          requestId: 'series-request',
          seriesName: 'Atomic series',
          launch: { repositoryId: 'repo-a', selections: { githubAccessId: null } },
          briefs: [
            { title: 'First', task: 'Implement first', dependsOn: [] },
            { title: 'Next', task: 'Implement next', dependsOn: ['First'] },
          ],
        },
        'user',
      );
      if (!series) throw new Error('Series service unavailable');
      expect(series.pods).toHaveLength(2);
      expect(series.pods[1]?.pod.branch).toBe(series.pods[0]?.pod.branch);
      for (const { pod: child } of series.pods) {
        expect(components.snapshots.get(child.id)?.origin?.kind).toBe('series');
        expect(ctx.podRepo.taskExecutions?.snapshot(child.id)).toBeTruthy();
        expect(ctx.enqueuedSessions).not.toContain(child.id);
      }
      const policy = components.policy.get();
      await new Promise<void>((resolve) => setImmediate(resolve));
      ctx.db.prepare("UPDATE pods SET status='failed' WHERE id=?").run(pod.id);
      const editedEnvironment = components.store.get('environment', 'env');
      components.store.write({
        ...editedEnvironment,
        expectedRevision: editedEnvironment.revision,
        payload: { ...editedEnvironment.payload, template: 'node24' },
      });
      const manual = await manager.fixManually(pod.id, identity.actor);
      const manualConfig = components.snapshots.get(manual.id);
      expect(manualConfig?.derivation).toEqual({
        kind: 'manual-fix',
        podId: pod.id,
        digest: saved.digest,
      });
      expect(manualConfig?.environment.template).toBe('node22');
      expect(manualConfig?.ai).toEqual(saved.ai);
      expect(manualConfig?.workflow.agentMode).toBe('interactive');
      expect(manualConfig?.workflow.validationPhases).toEqual([]);
      expect(manualConfig?.workflow.promotable).toBe(false);
      expect(manualConfig?.worker).toBeNull();
      expect(manual.linkedPodId).toBe(pod.id);
      expect(manual.branch).toBe(pod.branch);
      await expect(
        admit(
          {
            repositoryId: 'repo-b',
            task: 'Wrong repository follow-up',
            requestId: 'cross-repo-child',
            selections: { githubAccessId: null },
            work: { dependsOnPodIds: [pod.id] },
          },
          identity,
        ),
      ).rejects.toMatchObject({ code: 'DEPENDENCY_REPOSITORY_MISMATCH' });
      expect((await manager.fixManually(pod.id, identity.actor)).id).toBe(manual.id);
      accounts.create({
        id: 'goal-account',
        name: 'Goal account',
        provider: 'openai',
        credentials: {
          provider: 'openai',
          authMode: 'chatgpt',
          authJson: '{"tokens":{"access_token":"goal-fixture-token"}}',
        },
      });
      const goalPod = await admit(
        {
          repositoryId: 'repo-a',
          task: 'Native objective',
          intent: 'goal',
          selections: { githubAccessId: null },
          overrides: {
            ai: { main: { providerAccountId: 'goal-account', runtime: 'codex', model: 'gpt-5.5' } },
          },
          requestId: 'goal-guard',
        },
        identity,
      );
      ctx.podRepo.update(goalPod.id, { status: 'paused' });
      const pausedGoalPod = ctx.podRepo.getOrThrow(goalPod.id);
      await expect(manager.sendMessage(goalPod.id, 'Continue')).rejects.toMatchObject({
        code: 'GOAL_NATIVE_RESUME_REQUIRED',
      });
      expect(ctx.podRepo.getOrThrow(goalPod.id)).toEqual(pausedGoalPod);
      ctx.podRepo.update(goalPod.id, { status: 'failed' });
      const failedGoalPod = ctx.podRepo.getOrThrow(goalPod.id);
      await expect(manager.resumePod(goalPod.id)).rejects.toMatchObject({
        code: 'GOAL_NATIVE_RESUME_REQUIRED',
      });
      expect(() => manager.assertCanRework(goalPod.id)).toThrow('native Goal controls');
      expect(ctx.podRepo.getOrThrow(goalPod.id)).toEqual(failedGoalPod);
      components.policy.write(
        { ...policy.payload, blockedProviderAccountIds: ['account'] },
        policy.revision,
        'user',
      );
      await expect(components.launchConfiguration.assertCurrentCapabilities(saved)).rejects.toThrow(
        'revoked',
      );
      expect(provider.submit).not.toHaveBeenCalled();
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(ctx.enqueuedSessions).toEqual([
        pod.id,
        scheduled.id,
        series.pods[0]?.pod.id,
        manual.id,
        goalPod.id,
      ]);
    } finally {
      ctx.db.close();
    }
  });
});
