import type { Profile } from '@autopod/shared';
import { describe, expect, it } from 'vitest';
import {
  CLAUDE_DEFAULT_MODEL,
  CLAUDE_REVIEWER_MODEL,
  CODEX_DEFAULT_MODEL,
  resolvePodModel,
  resolvePodRuntime,
  resolveReviewerModel,
  resolveReviewerProvider,
} from './runtime-resolver.js';

function profile(overrides: Partial<Profile> = {}): Profile {
  return {
    name: 'test-profile',
    defaultRuntime: 'claude',
    defaultModel: CLAUDE_DEFAULT_MODEL,
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
    expect(
      resolvePodModel(profile({ defaultModel: 'claude-sonnet-4-6' }), undefined, 'claude'),
    ).toBe('claude-sonnet-4-6');
  });

  it('defaults Claude profiles to Opus 4.8 when no profile model is configured', () => {
    expect(resolvePodModel(profile({ defaultModel: null }), undefined, 'claude')).toBe(
      CLAUDE_DEFAULT_MODEL,
    );
  });

  it('keeps explicit canonical Opus 4.7 overrides', () => {
    expect(resolvePodModel(profile(), 'claude-opus-4-7', 'claude')).toBe('claude-opus-4-7');
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

describe('resolveReviewerProvider', () => {
  it('uses the profile model provider for review auth', () => {
    expect(resolveReviewerProvider(profile({ modelProvider: 'openai' }))).toBe('openai');
  });

  it('defaults legacy profiles to anthropic', () => {
    expect(resolveReviewerProvider(profile({ modelProvider: null }))).toBe('anthropic');
  });
});

describe('resolveReviewerModel', () => {
  it('uses reviewerModel when configured', () => {
    expect(resolveReviewerModel(profile({ reviewerModel: 'claude-sonnet-4-6' }))).toBe(
      'claude-sonnet-4-6',
    );
  });

  it('uses a Codex-compatible default for OpenAI profiles with stale Claude aliases', () => {
    expect(
      resolveReviewerModel(profile({ modelProvider: 'openai', reviewerModel: 'sonnet' })),
    ).toBe(CODEX_DEFAULT_MODEL);
  });

  it('defaults Claude-compatible review to sonnet when no model is configured', () => {
    expect(resolveReviewerModel(profile({ defaultModel: null, reviewerModel: null }))).toBe(
      CLAUDE_REVIEWER_MODEL,
    );
  });
});
