import { AsyncLocalStorage } from 'node:async_hooks';
import Anthropic from '@anthropic-ai/sdk';
import type { Logger } from 'pino';
import type { ConfigurationStore } from '../configuration/configuration-store.js';
import type { ProviderAccountStore } from '../provider-accounts/index.js';
import {
  assertRouteAccountHealthy,
  type ProviderAccountHealthStore,
} from '../provider-accounts/provider-account-health.js';
import { refreshAndPersistProviderAccountMaxCredentials } from '../providers/credential-persistence.js';

export interface MainProfilePin {
  profileName: string;
  profileId: string;
  profileRevision: number;
  aiId: string;
  aiRevision: number;
  accountId: string;
  model: string;
}
/** Host-owned main route only. Never resolve a workflow, alternate model or env credential.
 * The ledger enforces the lifetime limits independently of this transport's local ceiling. */
export function bindHostedControllerProfile(
  pin: MainProfilePin,
  config: Pick<ConfigurationStore, 'get'>,
  accounts: ProviderAccountStore,
  health: Pick<ProviderAccountHealthStore, 'current'>,
  logger: Logger,
  ordered = false,
) {
  const { profileId, aiId, accountId, model } = pin;
  const validate = () => {
    const p = config.get('profile', profileId),
      ai = config.get('ai', aiId);
    if (
      p.archived ||
      ai.archived ||
      p.name !== pin.profileName ||
      p.revision !== pin.profileRevision ||
      p.payload.aiId !== aiId ||
      ai.revision !== pin.aiRevision ||
      ai.payload.main.runtime !== 'claude' ||
      ai.payload.main.model !== model ||
      ai.payload.main.providerAccountId !== accountId
    )
      throw new Error('controller-route-changed');
    assertRouteAccountHealthy({ providerAccountId: accountId, failover: [] }, health);
  };
  if (ordered) validate(); // One-shot preflight; ordinary controls must survive a revoked route.
  let sent = 0;
  const beforeSend = new AsyncLocalStorage<() => void>();
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
        throw new Error('controller-request-limit');
      const payload = JSON.parse(body),
        ctx = JSON.parse(payload.messages[0].content);
      if (
        payload.model !== model ||
        payload.tools ||
        !['kickoff', 'results'].includes(ctx.phase) ||
        (ordered && ctx.phase !== (sent === 0 ? 'kickoff' : 'results'))
      )
        throw new Error('controller-request-shape');
      const a = accounts.get(accountId);
      const c = a.credentials;
      if (a.provider !== 'max' || c?.provider !== 'max')
        throw new Error('controller-account-unavailable');
      const token =
        'oauthToken' in c
          ? c.oauthToken
          : (await refreshAndPersistProviderAccountMaxCredentials(accounts, accountId, c, logger))
              .credentials.accessToken;
      if (!token) throw new Error('controller-account-unavailable');
      const outbound = JSON.stringify({ ...payload, max_tokens: 512 });
      if (Buffer.byteLength(outbound) > 8192 || sent >= 2)
        throw new Error('controller-request-limit');
      validate();
      init?.signal?.throwIfAborted();
      const reserve = beforeSend.getStore();
      if (!reserve && !ordered) throw new Error('controller-send-outside-turn');
      reserve?.();
      sent++;
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
        body: outbound,
      });
    },
  });
  return {
    client,
    model,
    atControllerSend: <T>(reserve: () => void, send: () => Promise<T>) =>
      beforeSend.run(reserve, send),
    preflightControllerRequest: (body: unknown) => {
      validate();
      if (Buffer.byteLength(JSON.stringify(body)) > 8192)
        throw new Error('controller-request-limit');
    },
  };
}
