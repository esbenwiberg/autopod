import { type NetworkPolicy, PROVIDER_CATALOG, type Profile } from '@autopod/shared';
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
});
