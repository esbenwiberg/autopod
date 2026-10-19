import {
  type NetworkPolicy,
  PROVIDER_CATALOG,
  type Profile,
  type ProviderAccount,
} from '@autopod/shared';
import { describe, expect, it } from 'vitest';
import { addRuntimeNetworkDefaults } from './runtime-network-defaults.js';

function profile(overrides: Partial<Profile> = {}): Profile {
  return {
    name: 'test-profile',
    defaultRuntime: 'claude',
    defaultModel: 'opus',
    modelProvider: 'anthropic',
    providerCredentials: null,
    ...overrides,
  } as Profile;
}

function foundryAccount(endpoint: string): ProviderAccount {
  return {
    id: 'acct-1',
    name: 'Foundry',
    provider: 'foundry',
    credentials: { provider: 'foundry', endpoint, apiKey: 'k' },
    failoverPolicy: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    lastAuthenticatedAt: null,
    lastUsedAt: null,
  };
}

function policy(overrides: Partial<NetworkPolicy> = {}): NetworkPolicy {
  return {
    enabled: true,
    mode: 'restricted',
    allowedHosts: ['example.com'],
    ...overrides,
  };
}

describe('addRuntimeNetworkDefaults', () => {
  it('adds Codex startup hosts for OpenAI-compatible pods', () => {
    const result = addRuntimeNetworkDefaults(
      policy(),
      profile({ modelProvider: 'openai' }),
      'codex',
    );

    expect(result?.allowedHosts).toContain('chatgpt.com');
    expect(result?.allowedHosts).toContain('*.chatgpt.com');
    expect(result?.allowedHosts).toContain('auth.openai.com');
    expect(result?.allowedHosts).not.toContain('github.com');
    expect(result?.allowedHosts).not.toContain('api.github.com');
  });

  it('adds Codex provider hosts for explicit replaceDefaults policies', () => {
    const result = addRuntimeNetworkDefaults(
      policy({ replaceDefaults: true }),
      profile({ modelProvider: 'openai' }),
      'codex',
    );

    expect(result?.allowedHosts).toContain('example.com');
    expect(result?.allowedHosts).toContain('chatgpt.com');
    expect(result?.allowedHosts).toContain('*.chatgpt.com');
    expect(result?.allowedHosts).toContain('auth.openai.com');
    expect(result?.allowedHosts).not.toContain('github.com');
    expect(result?.allowedHosts).not.toContain('api.github.com');
  });

  it('leaves non-Codex Anthropic pods unchanged', () => {
    const input = policy();

    expect(addRuntimeNetworkDefaults(input, profile(), 'claude')).toBe(input);
  });

  it('adds only reviewed hosts for a manifest provider under restricted policy', () => {
    const manifestProvider = PROVIDER_CATALOG.providers.find(({ id }) => id === 'kimi-code');
    const result = addRuntimeNetworkDefaults(
      policy(),
      profile({ modelProvider: 'pi' }),
      'pi',
      manifestProvider,
    );

    expect(result?.allowedHosts).toContain('api.kimi.com');
    expect(result?.allowedHosts).not.toContain('chatgpt.com');
    expect(result?.allowedHosts).not.toContain('*.chatgpt.com');
    expect(result?.allowedHosts).not.toContain('opencode.ai');
  });

  it('does not add manifest provider hosts outside restricted mode', () => {
    const manifestProvider = PROVIDER_CATALOG.providers.find(({ id }) => id === 'kimi-code');
    const input = policy({ mode: 'allow-all' });

    expect(
      addRuntimeNetworkDefaults(input, profile({ modelProvider: 'pi' }), 'pi', manifestProvider),
    ).toBe(input);
  });

  it('allows the Foundry resource host from a provider account', () => {
    const result = addRuntimeNetworkDefaults(
      policy(),
      profile(),
      'claude',
      null,
      foundryAccount('https://My-Res.services.ai.azure.com/anthropic'),
    );

    expect(result?.allowedHosts).toEqual(['example.com', 'my-res.services.ai.azure.com']);
  });

  it('allows the Foundry resource host from legacy profile credentials', () => {
    const result = addRuntimeNetworkDefaults(
      policy(),
      profile({
        modelProvider: 'foundry',
        providerCredentials: {
          provider: 'foundry',
          endpoint: 'https://legacy.openai.azure.com',
          apiKey: 'k',
          apiSurface: 'openai',
        },
      }),
      'codex',
    );

    expect(result?.allowedHosts).toContain('legacy.openai.azure.com');
  });

  it('prefers the provider account endpoint over stale profile credentials', () => {
    const result = addRuntimeNetworkDefaults(
      policy(),
      profile({
        modelProvider: 'foundry',
        providerCredentials: {
          provider: 'foundry',
          endpoint: 'https://stale.services.ai.azure.com',
          apiKey: 'k',
        },
      }),
      'claude',
      null,
      foundryAccount('https://current.services.ai.azure.com'),
    );

    expect(result?.allowedHosts).toContain('current.services.ai.azure.com');
    expect(result?.allowedHosts).not.toContain('stale.services.ai.azure.com');
  });

  it.each([
    'https://gateway.example.com/anthropic',
    'http://res.services.ai.azure.com',
    'https://res.services.ai.azure.com:8443',
    'https://services.ai.azure.com.evil.example',
  ])('never auto-allows a non-canonical Foundry endpoint (%s)', (endpoint) => {
    const input = policy();

    expect(
      addRuntimeNetworkDefaults(input, profile(), 'claude', null, foundryAccount(endpoint)),
    ).toBe(input);
  });

  it('does not add Foundry hosts outside restricted mode', () => {
    const input = policy({ mode: 'allow-all' });

    expect(
      addRuntimeNetworkDefaults(
        input,
        profile(),
        'claude',
        null,
        foundryAccount('https://res.services.ai.azure.com'),
      ),
    ).toBe(input);
  });
});
