import type { ProviderAccount } from '@autopod/shared';
import pino from 'pino';
import { describe, expect, it, vi } from 'vitest';
import type { ContainerManager } from '../interfaces/container-manager.js';
import type { ProviderAccountStore } from '../provider-accounts/index.js';
import { persistProviderAccountCredentials } from '../providers/credential-persistence.js';
import { buildProviderAccountEnv } from '../providers/env-builder.js';

function storeFor(account: ProviderAccount): ProviderAccountStore {
  let current = structuredClone(account);
  return {
    get: vi.fn(() => structuredClone(current)),
    touchLastUsed: vi.fn(),
    updateCredentials: vi.fn((_id, credentials) => {
      current = { ...current, credentials };
      return structuredClone(current);
    }),
  } as unknown as ProviderAccountStore;
}

function account(provider: string, credentials: ProviderAccount['credentials']): ProviderAccount {
  return {
    id: `${provider}-decision`,
    name: `${provider} decision`,
    provider,
    credentials,
    failoverPolicy: null,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    lastAuthenticatedAt: new Date(0).toISOString(),
    lastUsedAt: null,
  };
}

describe('system provider auth', () => {
  it('prepares only the dedicated account for each compatible runtime', async () => {
    const fixtures = [
      ['anthropic', 'claude', { provider: 'anthropic', apiKey: 'anthropic-secret' }],
      [
        'max',
        'claude',
        {
          provider: 'max',
          oauthToken: 'max-secret',
        },
      ],
      [
        'openai',
        'codex',
        {
          provider: 'openai',
          authMode: 'chatgpt',
          authJson: '{"tokens":{"access_token":"secret"}}',
        },
      ],
      ['copilot', 'copilot', { provider: 'copilot', token: 'copilot-secret' }],
      [
        'pi',
        'pi',
        {
          provider: 'pi',
          providerId: 'anthropic',
          credential: { access: 'pi-secret' },
        },
      ],
    ] as const;
    for (const [provider, runtime, credentials] of fixtures) {
      const providerAccountStore = storeFor(account(provider, credentials));
      const result = await buildProviderAccountEnv(
        `${provider}-decision`,
        pino({ level: 'silent' }),
        {
          providerAccountStore,
          runtime,
        },
      );
      expect(result.credentialOwner).toEqual({
        type: 'provider-account',
        id: `${provider}-decision`,
      });
      expect(providerAccountStore.touchLastUsed).toHaveBeenCalledWith(`${provider}-decision`);
    }
  });

  it('readback updates only the configured provider account owner', async () => {
    const providerAccountStore = storeFor(
      account('openai', {
        provider: 'openai',
        authMode: 'chatgpt',
        authJson: '{"old":true}',
      }),
    );
    const manager = {
      readFile: vi.fn(async () => '{"tokens":{"access_token":"rotated"}}'),
    } as unknown as ContainerManager;
    await persistProviderAccountCredentials(
      'container-1',
      manager,
      providerAccountStore,
      'openai-decision',
      pino({ level: 'silent' }),
      { openAi: true },
    );
    expect(providerAccountStore.updateCredentials).toHaveBeenCalledOnce();
    expect(providerAccountStore.updateCredentials).toHaveBeenCalledWith(
      'openai-decision',
      expect.objectContaining({ provider: 'openai' }),
    );
  });

  it('rejects runtime/account mismatches without a profile fallback', async () => {
    const providerAccountStore = storeFor(
      account('openai', {
        provider: 'openai',
        authMode: 'chatgpt',
        authJson: '{}',
      }),
    );
    await expect(
      buildProviderAccountEnv('openai-decision', pino({ level: 'silent' }), {
        providerAccountStore,
        runtime: 'claude',
      }),
    ).rejects.toThrow(/incompatible/);
  });

  it('rejects an account that would otherwise fall back to a daemon API key', async () => {
    const providerAccountStore = storeFor(account('openai', { provider: 'openai' }));
    await expect(
      buildProviderAccountEnv('openai-decision', pino({ level: 'silent' }), {
        providerAccountStore,
        runtime: 'codex',
      }),
    ).rejects.toThrow(/no stored Codex authentication state/);
  });
});
