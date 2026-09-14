import { agentRouteSchema } from '@autopod/shared';
import { describe, expect, it } from 'vitest';
import { createProviderAccountStore } from '../provider-accounts/provider-account-store.js';
import { createTestDb } from '../test-utils/mock-helpers.js';
import { assertLaunchAgentAccount, resolveLaunchAgentRoute } from './agent-route-resolution.js';

describe('launch account identity', () => {
  it('rejects environment fallback, revoked credentials, identity replacement and mismatched runtime', () => {
    const db = createTestDb();
    try {
      const store = createProviderAccountStore(db);
      store.create({
        id: 'account',
        name: 'AI',
        provider: 'anthropic',
        credentials: { provider: 'anthropic' },
      });
      const route = agentRouteSchema.parse({
        providerAccountId: 'account',
        runtime: 'claude',
        model: 'claude-sonnet-4-6',
      });
      expect(() => resolveLaunchAgentRoute(route, store)).toThrow('explicitly');
      store.updateCredentials('account', { provider: 'anthropic', apiKey: 'fixture-key' });
      const binding = resolveLaunchAgentRoute(route, store);
      expect(JSON.stringify(binding)).not.toContain('fixture-key');
      expect(() =>
        assertLaunchAgentAccount(route, { ...binding, createdAt: 'different-account' }, store),
      ).toThrow('identity');
      expect(() => resolveLaunchAgentRoute({ ...route, runtime: 'codex' }, store)).toThrow(
        'claude',
      );
      store.updateCredentials('account', null);
      expect(() => assertLaunchAgentAccount(route, binding, store)).toThrow('not authenticated');
    } finally {
      db.close();
    }
  });
});
