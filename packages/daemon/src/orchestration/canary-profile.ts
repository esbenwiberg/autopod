import Anthropic from '@anthropic-ai/sdk';
import type { Logger } from 'pino';
import type { ConfigurationStore } from '../configuration/configuration-store.js';
import type { ProviderAccountStore } from '../provider-accounts/index.js';
import {
  assertRouteAccountHealthy,
  type ProviderAccountHealthStore,
} from '../provider-accounts/provider-account-health.js';
import { refreshAndPersistProviderAccountMaxCredentials } from '../providers/credential-persistence.js';

// This trial consents to precisely the main route observed at preflight. Changes require review.
const profileId = 'profile-f3ec3b28e6369a8879e2a1da',
  aiId = 'ai-2aa5da9e201c0adf52150c71',
  accountId = 'anth-pro',
  model = 'claude-sonnet-5-5';
export function bindCanaryProfile(
  config: Pick<ConfigurationStore, 'get'>,
  accounts: ProviderAccountStore,
  health: Pick<ProviderAccountHealthStore, 'current'>,
  logger: Logger,
) {
  const validate = () => {
    const p = config.get('profile', profileId),
      ai = config.get('ai', aiId);
    if (
      p.name !== 'repofit' ||
      p.revision !== 2 ||
      p.payload.aiId !== aiId ||
      ai.revision !== 8 ||
      ai.payload.main.runtime !== 'claude' ||
      ai.payload.main.model !== model ||
      ai.payload.main.providerAccountId !== accountId
    )
      throw new Error('canary-route-changed');
    assertRouteAccountHealthy({ providerAccountId: accountId, failover: [] }, health);
  };
  validate();
  let sent = 0;
  // A placeholder SDK emits the normal controller request. Resolve auth on its one permitted
  // wire path, after ledger reservation. No SDK env endpoint, failover, redirects or tools.
  const client = new Anthropic({
    apiKey: 'unused',
    authToken: null,
    baseURL: 'https://api.anthropic.com',
    maxRetries: 0,
    fetch: async (url, init) => {
      validate();
      const body = String(init?.body);
      if (
        sent >= 2 ||
        String(url) !== 'https://api.anthropic.com/v1/messages' ||
        Buffer.byteLength(body) > 8192
      )
        throw new Error('canary-request-limit');
      const payload = JSON.parse(body),
        ctx = JSON.parse(payload.messages[0].content);
      if (
        payload.model !== model ||
        payload.tools ||
        ctx.phase !== (sent === 0 ? 'kickoff' : 'results')
      )
        throw new Error('canary-request-shape');
      sent++;
      const a = accounts.get(accountId);
      const c = a.credentials;
      if (a.provider !== 'max' || c?.provider !== 'max')
        throw new Error('canary-account-unavailable');
      const token =
        'oauthToken' in c
          ? c.oauthToken
          : (await refreshAndPersistProviderAccountMaxCredentials(accounts, accountId, c, logger))
              .credentials.accessToken;
      if (!token) throw new Error('canary-account-unavailable');
      return fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        redirect: 'error',
        signal: init?.signal,
        headers: {
          'anthropic-version': '2023-06-01',
          'anthropic-beta': 'oauth-2025-04-20',
          'content-type': 'application/json',
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ ...payload, max_tokens: 512 }),
      });
    },
  });
  return { client, model };
}
