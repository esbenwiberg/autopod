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

// Never forward provider-controlled text to diagnostics. These are hints about
// an error response, not verdicts on credentials or permissions.
function providerHint(err: unknown) {
  if (!(err instanceof Anthropic.APIError)) return undefined;
  const msg = err.message.toLowerCase();
  if (msg.includes('claude code') && /only|cannot|not (?:valid|allowed)|restricted/.test(msg))
    return 'client-restricted';
  if (/oauth.{0,60}not supported|does not support.{0,60}oauth/.test(msg))
    return 'oauth-unsupported';
  if (/expired|revoked/.test(msg)) return 'credential-expiry-or-revocation';
  if (/credit balance|billing/.test(msg)) return 'billing';
  if (/model.{0,100}(?:not found|not available|does not exist|not supported)/.test(msg))
    return 'model-unavailable';
  return [
    'authentication_error',
    'permission_error',
    'rate_limit_error',
    'not_found_error',
    'invalid_request_error',
    'overloaded_error',
    'api_error',
    'billing_error',
  ].find((v) => v === err.type);
}

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
  type Attempt = {
    reserve: () => void;
    reserved: boolean;
    phase?: 'kickoff' | 'results';
    signal?: AbortSignal | null;
    status?: number;
  };
  const beforeSend = new AsyncLocalStorage<Attempt>();
  // A placeholder SDK emits the normal controller request. Resolve auth on its one permitted
  // wire path, after ledger reservation. No SDK env endpoint, failover, redirects or tools.
  const client = new Anthropic({
    apiKey: 'unused',
    authToken: null,
    baseURL: 'https://api.anthropic.com',
    maxRetries: 0,
    logLevel: 'off', // Never let SDK debug output include provider payloads.
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
      const attempt = beforeSend.getStore();
      if (!attempt || attempt.reserved) throw new Error('controller-send-outside-turn');
      attempt.phase = ctx.phase;
      attempt.signal = init?.signal;
      attempt.reserve();
      attempt.reserved = true;
      sent++;
      const response = await fetch('https://api.anthropic.com/v1/messages', {
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
      attempt.status = response.status;
      return response;
    },
  });
  return {
    client,
    model,
    atControllerSend: async <T>(
      reserve: () => void,
      send: () => Promise<T>,
      wakeDigest?: string,
    ) => {
      const attempt: Attempt = { reserve, reserved: false };
      try {
        return await beforeSend.run(attempt, send);
      } catch (err) {
        if (!attempt.reserved) throw err;
        const status = attempt.status;
        const reason =
          status !== undefined && status >= 300 && status <= 599
            ? `controller-provider-http-${status}`
            : attempt.signal?.aborted
              ? 'controller-provider-aborted'
              : status === undefined
                ? 'controller-provider-no-response'
                : 'controller-provider-response-unreadable';
        // Only locally derived fields. No error object/cause, request or response headers/body.
        logger.warn(
          {
            reason,
            phase: attempt.phase,
            httpStatus: status,
            providerHint: status && status >= 400 ? providerHint(err) : undefined,
            wakeDigest:
              wakeDigest && /^sha256:[a-f0-9]{64}$/.test(wakeDigest) ? wakeDigest : undefined,
          },
          'Hosted controller request failed after reservation',
        );
        throw new Error(reason);
      }
    },
    preflightControllerRequest: (body: unknown) => {
      validate();
      if (Buffer.byteLength(JSON.stringify(body)) > 8192)
        throw new Error('controller-request-limit');
    },
  };
}
