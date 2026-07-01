import type { MaxRefreshCredentials, Profile } from '@autopod/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createProfileAnthropicClient,
  createProviderAnthropicClient,
  resolveAnthropicModelId,
} from './llm-client.js';

const logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
} as unknown as import('pino').Logger;

describe('resolveAnthropicModelId', () => {
  it('expands defensive Claude aliases to current canonical profile targets', () => {
    expect(resolveAnthropicModelId('opus')).toBe('claude-opus-4-8');
    expect(resolveAnthropicModelId('sonnet')).toBe('claude-sonnet-4-6');
    expect(resolveAnthropicModelId('haiku')).toBe('claude-haiku-4-5');
  });

  it('passes canonical model IDs through unchanged', () => {
    expect(resolveAnthropicModelId('claude-opus-4-7')).toBe('claude-opus-4-7');
    expect(resolveAnthropicModelId('claude-opus-4-8')).toBe('claude-opus-4-8');
  });
});

describe('createProviderAnthropicClient — MAX refresh resilience', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  const expiredCreds: MaxRefreshCredentials = {
    provider: 'max',
    accessToken: 'old-access',
    refreshToken: 'revoked-refresh',
    // Already expired → forces a refresh attempt.
    expiresAt: new Date(Date.now() - 60_000).toISOString(),
  };

  it('returns refresh_failed instead of throwing when the OAuth refresh is rejected', async () => {
    // Anthropic surfaces a consumed/rotated refresh token as 400 invalid_grant.
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response('{"error":"invalid_grant"}', {
            status: 400,
            headers: { 'Content-Type': 'application/json' },
          }),
      ),
    );

    const result = await createProviderAnthropicClient(
      { provider: 'max', credentials: expiredCreds, model: 'sonnet', profileName: 'p' },
      logger,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('refresh_failed');
  });
});

describe('createProfileAnthropicClient — provider-account resolution', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('uses the linked provider account credentials, not the stale profile column', async () => {
    // Profile carries a stale inline setup-token that would auth as a different
    // (revoked) identity if used; the linked account holds the live token.
    const profile = {
      name: 'teamplanner-agent',
      modelProvider: 'max',
      providerAccountId: 'anth-pro',
      providerCredentials: { provider: 'max', oauthToken: 'STALE-profile-token' },
    } as unknown as Profile;

    const providerAccountStore = {
      get: vi.fn(() => ({
        id: 'anth-pro',
        provider: 'max',
        credentials: { provider: 'max', oauthToken: 'LIVE-account-token' },
      })),
      touchLastUsed: vi.fn(),
    } as unknown as import('../provider-accounts/index.js').ProviderAccountStore;

    const result = await createProfileAnthropicClient(profile, 'sonnet', logger, {
      providerAccountStore,
    });

    expect(result.ok).toBe(true);
    // Setup-token creds require no refresh, so a client is built directly. The
    // account store must have been the credential source.
    expect(providerAccountStore.get).toHaveBeenCalledWith('anth-pro');
  });
});
