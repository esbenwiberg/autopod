import type { NetworkPolicy, Profile } from '@autopod/shared';
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
    expect(result?.allowedHosts).toContain('github.com');
    expect(result?.allowedHosts).toContain('api.github.com');
  });

  it('does not override explicit replaceDefaults policies', () => {
    const result = addRuntimeNetworkDefaults(
      policy({ replaceDefaults: true }),
      profile({ modelProvider: 'openai' }),
      'codex',
    );

    expect(result?.allowedHosts).toEqual(['example.com']);
  });

  it('leaves non-Codex Anthropic pods unchanged', () => {
    const input = policy();

    expect(addRuntimeNetworkDefaults(input, profile(), 'claude')).toBe(input);
  });
});
