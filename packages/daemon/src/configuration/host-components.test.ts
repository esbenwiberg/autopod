import type Dockerode from 'dockerode';
import { describe, expect, it, vi } from 'vitest';
import { createActionAuditRepository } from '../actions/audit-repository.js';
import { createProviderAccountStore } from '../provider-accounts/provider-account-store.js';
import { createTestConfiguration } from '../test-utils/configuration-helpers.js';
import { createTestContext } from '../test-utils/mock-helpers.js';
import {
  createHostConfigurationComponents,
  hostConfigurationSettingsSchema,
} from './host-components.js';
import { resolveLaunch } from './launch-resolver.js';

describe('configuration host composition', () => {
  it('exposes actual backend limits while keeping closed admission and unenrolled PIM closed', async () => {
    const ctx = createTestContext();
    try {
      const fixture = createTestConfiguration(ctx.db);
      const accounts = createProviderAccountStore(ctx.db);
      accounts.create({
        id: 'account',
        name: 'Account',
        provider: 'anthropic',
        credentials: { provider: 'anthropic', apiKey: 'fixture-key' },
      });
      const githubAuth = {
        resolveCredential: vi.fn(async () => ({
          token: 'protected-fixture',
          username: 'operator',
        })),
        getStatus: vi.fn(),
      };
      const podManager = vi.fn(() => {
        throw new Error('Pod manager must not be called before cutover');
      });
      const components = createHostConfigurationComponents({
        db: ctx.db,
        logger: ctx.deps.logger,
        pods: ctx.podRepo,
        accounts,
        audit: createActionAuditRepository(ctx.db),
        cipher: { encrypt: (value) => `fixture:${value}`, decrypt: (value) => value.slice(8) },
        githubAuth,
        azureDevOpsAuth: { getToken: vi.fn() },
        images: {
          resolveEnvironment: fixture.services.resolveEnvironment,
          buildEnvironmentImage: vi.fn(),
        },
        reviewerManager: () => ctx.containerManager,
        docker: {
          info: async () => ({ MemTotal: 8 * 1024 ** 3, NCPU: 4 }),
        } as unknown as Dockerode,
        sandboxEnabled: false,
        sandboxDefaultTier: 'M',
        settings: hostConfigurationSettingsSchema.parse({
          reviewerImages: { local: `trusted/reviewer@sha256:${'a'.repeat(64)}` },
        }),
        podManager,
        admissionReady: () => ({ ready: false, reason: 'Cutover incomplete' }),
      });
      expect(components.scopedTools.pimRoutes).toBeUndefined();
      expect(await components.routes.capabilities()).toMatchObject({
        launchAvailable: false,
        nativeGoals: [],
        execution: [{ available: true, maxMemoryGb: 8 }, { available: false }],
      });
      expect(githubAuth.resolveCredential).not.toHaveBeenCalled();
      await expect(
        components.routes.admit?.(
          {},
          { userId: 'operator', actor: { type: 'human', userId: 'operator' } },
        ),
      ).rejects.toThrow('Cutover');
      expect(podManager).not.toHaveBeenCalled();
      const request = {
        repositoryId: 'repo-a',
        task: 'Review configuration',
        selections: { githubAccessId: null },
      };
      await expect(resolveLaunch(request, components.resolution)).resolves.toMatchObject({
        intent: 'task',
      });
      await expect(
        resolveLaunch({ ...request, intent: 'goal' }, components.resolution),
      ).rejects.toMatchObject({ code: 'GOAL_UNAVAILABLE' });
      await expect(
        components.routes.credentials?.create({
          name: 'Repackaged source token',
          purposes: ['build-env'],
          origins: ['https://service.example.test'],
          value: 'protected-fixture',
        }),
      ).rejects.toMatchObject({ code: 'SOURCE_CREDENTIAL_FORBIDDEN' });
      expect(ctx.db.prepare('SELECT COUNT(*) AS n FROM configuration_credentials').get()).toEqual({
        n: 0,
      });
    } finally {
      ctx.db.close();
    }
  });
});
