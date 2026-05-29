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
});
