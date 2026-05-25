import type { Profile } from '@autopod/shared';
import { describe, expect, it } from 'vitest';
import { CODEX_DEFAULT_MODEL, resolvePodModel, resolvePodRuntime } from './runtime-resolver.js';

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

describe('resolvePodModel', () => {
  it('uses the profile default for Anthropic profiles', () => {
    expect(resolvePodModel(profile({ defaultModel: 'sonnet' }), undefined, 'claude')).toBe(
      'sonnet',
    );
  });

  it('uses the Codex default for OpenAI profiles with stale Claude aliases', () => {
    expect(
      resolvePodModel(
        profile({ modelProvider: 'openai', defaultModel: 'sonnet' }),
        undefined,
        'codex',
      ),
    ).toBe(CODEX_DEFAULT_MODEL);
  });

  it('uses the Codex default for ChatGPT auth with the old platform Codex default', () => {
    expect(
      resolvePodModel(
        profile({
          modelProvider: 'openai',
          defaultModel: 'gpt-5-codex',
          providerCredentials: { provider: 'openai', authMode: 'chatgpt', authJson: '{}' },
        }),
        undefined,
        'codex',
      ),
    ).toBe(CODEX_DEFAULT_MODEL);
  });

  it('keeps explicit GPT models for OpenAI profiles', () => {
    expect(resolvePodModel(profile({ modelProvider: 'openai' }), 'gpt-5', 'codex')).toBe('gpt-5');
  });
});
