import { describe, expect, it, vi } from 'vitest';
import { createTestContext } from '../test-utils/mock-helpers.js';
import { createPodManager } from './pod-manager.js';

describe('daemon-owned source credentials', () => {
  it('rejects mutable profile network refresh before reading a profile or touching running pods', async () => {
    const ctx = createTestContext();
    try {
      const manager = createPodManager({
        ...ctx.deps,
        launchConfiguration: {
          read: () => null,
          executionSettings: () => {
            throw new Error('No profile projection permitted');
          },
          assertCurrentCapabilities: async () => {},
          prepareEnvironment: async () => 'unused',
        },
      });
      await expect(manager.refreshNetworkPolicy('shared')).rejects.toMatchObject({
        code: 'CONFIG_API_VERSION_UNSUPPORTED',
      });
      expect(ctx.profileStore.get).not.toHaveBeenCalled();
      expect(ctx.deps.containerManagerFactory.get).not.toHaveBeenCalled();
    } finally {
      ctx.db.close();
    }
  });
  it.each(['github', 'ado'] as const)(
    'rejects direct %s injection before resolving or writing a credential',
    async (service) => {
      const ctx = createTestContext();
      const resolveCredential = vi.fn();
      const getToken = vi.fn();
      try {
        const manager = createPodManager({
          ...ctx.deps,
          githubAuth: { resolveCredential } as unknown as NonNullable<typeof ctx.deps.githubAuth>,
          azureDevOpsAuth: { getToken } as unknown as NonNullable<typeof ctx.deps.azureDevOpsAuth>,
        });
        await expect(manager.injectCredential('any-pod', service)).rejects.toMatchObject({
          code: 'SOURCE_CREDENTIAL_INJECTION_DISABLED',
          statusCode: 410,
        });
        expect(resolveCredential).not.toHaveBeenCalled();
        expect(getToken).not.toHaveBeenCalled();
        expect(ctx.deps.containerManagerFactory.get).not.toHaveBeenCalled();
      } finally {
        ctx.db.close();
      }
    },
  );
});
