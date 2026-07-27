import { describe, expect, it } from 'vitest';
import {
  CLAUDE_DEFAULT_MODEL,
  CLAUDE_REVIEWER_MODEL,
  MODEL_CANONICAL,
  MODEL_PRICING,
  canonicalModelKey,
  computeCost,
  computeCostWithCache,
  effectiveCostUsd,
} from './index.js';

describe('MODEL_PRICING', () => {
  it('has Claude 5 standard pricing, defaults, and stable historical aliases', () => {
    expect(MODEL_PRICING['claude-fable-5']).toEqual({
      inputPer1M: 10,
      cachedInputPer1M: 1,
      outputPer1M: 50,
    });
    expect(MODEL_PRICING['claude-opus-5']).toEqual({
      inputPer1M: 5,
      cachedInputPer1M: 0.5,
      outputPer1M: 25,
    });
    expect(MODEL_PRICING['claude-sonnet-5']).toEqual({
      inputPer1M: 3,
      cachedInputPer1M: 0.3,
      outputPer1M: 15,
    });
    expect(CLAUDE_DEFAULT_MODEL).toBe('claude-opus-5');
    expect(CLAUDE_REVIEWER_MODEL).toBe('claude-sonnet-5');
    expect(CLAUDE_DEFAULT_MODEL).not.toBe('claude-fable-5');
    expect(MODEL_CANONICAL).toEqual({
      opus: 'claude-opus-4-7',
      sonnet: 'claude-sonnet-4-6',
      haiku: 'claude-haiku-4-5',
    });
    expect(canonicalModelKey('claude-fable-5')).toBe('claude-fable-5');
    expect(canonicalModelKey('claude-opus-5')).toBe('claude-opus-5');
    expect(canonicalModelKey('claude-sonnet-5')).toBe('claude-sonnet-5');
  });

  it('contains full claude model IDs', () => {
    expect(MODEL_PRICING['claude-opus-4-8']).toBeDefined();
    expect(MODEL_PRICING['claude-opus-4-7']).toBeDefined();
    expect(MODEL_PRICING['claude-opus-4-6']).toBeDefined();
    expect(MODEL_PRICING['claude-sonnet-4-6']).toBeDefined();
    expect(MODEL_PRICING['claude-sonnet-4-5']).toBeDefined();
    expect(MODEL_PRICING['claude-haiku-4-5']).toBeDefined();
  });

  it('contains gpt model IDs', () => {
    expect(MODEL_PRICING['gpt-5.6-sol']).toBeDefined();
    expect(MODEL_PRICING['gpt-5.6-terra']).toBeDefined();
    expect(MODEL_PRICING['gpt-5.6-luna']).toBeDefined();
    expect(MODEL_PRICING['gpt-5.5']).toBeDefined();
    expect(MODEL_PRICING['gpt-5']).toBeDefined();
    expect(MODEL_PRICING['gpt-5-mini']).toBeDefined();
    expect(MODEL_PRICING['gpt-5.3-codex']).toBeDefined();
    expect(MODEL_PRICING['gpt-5.2-codex']).toBeDefined();
    expect(MODEL_PRICING['gpt-5.1-codex']).toBeDefined();
    expect(MODEL_PRICING['gpt-5-codex']).toBeDefined();
  });

  it('keeps legacy short aliases out of the canonical price table', () => {
    expect(MODEL_PRICING.opus).toBeUndefined();
    expect(MODEL_PRICING.sonnet).toBeUndefined();
    expect(MODEL_PRICING.haiku).toBeUndefined();
  });

  it('contains claude-opus-4-8 with the same price as claude-opus-4-7', () => {
    expect(MODEL_PRICING['claude-opus-4-8']).toEqual(MODEL_PRICING['claude-opus-4-7']);
  });
});

describe('computeCost', () => {
  it('computes input-only cost for claude-opus-4-7', () => {
    expect(computeCost('claude-opus-4-7', 1_000_000, 0)).toBe(5.0);
  });

  it('computes output-only cost for claude-opus-4-7', () => {
    expect(computeCost('claude-opus-4-7', 0, 1_000_000)).toBe(25.0);
  });

  it('computes blended cost for claude-opus-4-7', () => {
    expect(computeCost('claude-opus-4-7', 500_000, 500_000)).toBe(15.0);
  });

  it('computes blended cost for claude-opus-4-8', () => {
    expect(computeCost('claude-opus-4-8', 500_000, 500_000)).toBe(15.0);
  });

  it('prices historical short aliases through their original canonical IDs', () => {
    expect(computeCost('opus', 1_000_000, 0)).toBe(computeCost('claude-opus-4-7', 1_000_000, 0));
    expect(computeCost('sonnet', 1_000_000, 0)).toBe(
      computeCost('claude-sonnet-4-6', 1_000_000, 0),
    );
    expect(computeCost('haiku', 1_000_000, 0)).toBe(computeCost('claude-haiku-4-5', 1_000_000, 0));
  });

  it('returns 0 for null model', () => {
    expect(computeCost(null, 100, 100)).toBe(0);
  });

  it('returns 0 for unknown model', () => {
    expect(computeCost('unknown-model', 100, 100)).toBe(0);
  });
});

describe('computeCostWithCache', () => {
  it('computes GPT-5.6 family costs with cached input discounts', () => {
    expect(computeCostWithCache('gpt-5.6-sol', 1_000_000, 500_000, 250_000)).toBe(
      0.75 * 5.0 + 0.25 * 0.5 + 0.5 * 30.0,
    );
    expect(computeCostWithCache('gpt-5.6-terra', 1_000_000, 500_000, 250_000)).toBe(
      0.75 * 2.5 + 0.25 * 0.25 + 0.5 * 15.0,
    );
    expect(computeCostWithCache('gpt-5.6-luna', 1_000_000, 500_000, 250_000)).toBe(
      0.75 * 1.0 + 0.25 * 0.1 + 0.5 * 6.0,
    );
  });

  it('computes Codex cost with cached input discount', () => {
    expect(computeCostWithCache('gpt-5.3-codex', 1_000_000, 500_000, 250_000)).toBe(
      0.75 * 1.75 + 0.25 * 0.175 + 0.5 * 14.0,
    );
  });

  it('computes Claude cost with cached input discount', () => {
    expect(computeCostWithCache('claude-haiku-4-5', 1_000_000, 0, 900_000)).toBe(
      0.1 * 1.0 + 0.9 * 0.1,
    );
  });

  it('applies canonical cached-input pricing to historical aliases', () => {
    expect(computeCostWithCache('opus', 1_000_000, 0, 900_000)).toBe(
      computeCostWithCache('claude-opus-4-7', 1_000_000, 0, 900_000),
    );
  });
});

describe('effectiveCostUsd', () => {
  it('returns costUsd directly when it is non-zero (Claude path)', () => {
    expect(
      effectiveCostUsd({
        costUsd: 1.23,
        model: 'claude-opus-4-7',
        inputTokens: 1_000_000,
        outputTokens: 0,
      }),
    ).toBe(1.23);
  });

  it('computes from tokens when costUsd is 0 (non-Claude path)', () => {
    expect(
      effectiveCostUsd({ costUsd: 0, model: 'gpt-5', inputTokens: 1_000_000, outputTokens: 0 }),
    ).toBe(1.25);
  });

  it('returns 0 when costUsd is 0 and model is unknown', () => {
    expect(
      effectiveCostUsd({
        costUsd: 0,
        model: 'unknown',
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
      }),
    ).toBe(0);
  });

  it('prices a historical alias when no recorded vendor cost exists', () => {
    expect(
      effectiveCostUsd({
        costUsd: 0,
        model: 'opus',
        inputTokens: 1_000_000,
        outputTokens: 0,
      }),
    ).toBe(5);
  });
});

describe('canonicalModelKey', () => {
  it('resolves short alias opus → claude-opus-4-7', () => {
    expect(canonicalModelKey('opus')).toBe('claude-opus-4-7');
  });

  it('resolves short alias sonnet → claude-sonnet-4-6', () => {
    expect(canonicalModelKey('sonnet')).toBe('claude-sonnet-4-6');
  });

  it('resolves short alias haiku → claude-haiku-4-5', () => {
    expect(canonicalModelKey('haiku')).toBe('claude-haiku-4-5');
  });

  it('returns full canonical ID when already canonical', () => {
    expect(canonicalModelKey('claude-opus-4-7')).toBe('claude-opus-4-7');
  });

  it('returns claude-opus-4-8 when provided as a full canonical ID', () => {
    expect(canonicalModelKey('claude-opus-4-8')).toBe('claude-opus-4-8');
  });

  it('returns null for unknown model string', () => {
    expect(canonicalModelKey('mystery')).toBeNull();
  });

  it('returns null for null input', () => {
    expect(canonicalModelKey(null)).toBeNull();
  });

  it('returns null for undefined input', () => {
    expect(canonicalModelKey(undefined)).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(canonicalModelKey('')).toBeNull();
  });
});
