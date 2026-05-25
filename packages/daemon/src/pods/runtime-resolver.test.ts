import type { Profile } from '@autopod/shared';
import { describe, expect, it } from 'vitest';
import { resolvePodRuntime } from './runtime-resolver.js';

function profile(overrides: Partial<Profile> = {}): Profile {
  return {
    name: 'test-profile',
    defaultRuntime: 'claude',
    modelProvider: 'anthropic',
    providerCredentials: null,
    ...overrides,
  } as Profile;
}

describe('resolvePodRuntime', () => {
  it('uses the profile default for Anthropic profiles', () => {
    expect(resolvePodRuntime(profile({ defaultRuntime: 'claude' }), undefined)).toBe('claude');
  });

  it('forces Codex for OpenAI profiles even when the stored default is Claude', () => {
    expect(resolvePodRuntime(profile({ modelProvider: 'openai' }), undefined)).toBe('codex');
  });

  it('forces Codex for OpenAI profiles even when a request asks for Claude', () => {
    expect(resolvePodRuntime(profile({ modelProvider: 'openai' }), 'claude')).toBe('codex');
  });

  it('forces Codex for Foundry OpenAI-surface profiles', () => {
    expect(
      resolvePodRuntime(
        profile({
          modelProvider: 'foundry',
          providerCredentials: {
            provider: 'foundry',
            endpoint: 'https://foundry.example',
            projectId: 'gpt',
            apiSurface: 'openai',
          },
        }),
        undefined,
      ),
    ).toBe('codex');
  });
});
