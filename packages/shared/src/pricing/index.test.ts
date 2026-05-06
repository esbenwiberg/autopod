import { describe, expect, it } from 'vitest';
import { MODEL_PRICING, computeCost, effectiveCostUsd } from './index.js';

describe('MODEL_PRICING', () => {
  it('contains full claude model IDs', () => {
    expect(MODEL_PRICING['claude-opus-4-7']).toBeDefined();
    expect(MODEL_PRICING['claude-sonnet-4-6']).toBeDefined();
    expect(MODEL_PRICING['claude-sonnet-4-5']).toBeDefined();
    expect(MODEL_PRICING['claude-haiku-4-5']).toBeDefined();
  });

  it('contains gpt model IDs', () => {
    expect(MODEL_PRICING['gpt-5']).toBeDefined();
    expect(MODEL_PRICING['gpt-5-mini']).toBeDefined();
  });

  it('contains short aliases', () => {
    expect(MODEL_PRICING.opus).toBeDefined();
    expect(MODEL_PRICING.sonnet).toBeDefined();
    expect(MODEL_PRICING.haiku).toBeDefined();
  });
});

describe('computeCost', () => {
  it('computes input-only cost for claude-opus-4-7', () => {
    expect(computeCost('claude-opus-4-7', 1_000_000, 0)).toBe(15.0);
  });

  it('computes output-only cost for claude-opus-4-7', () => {
    expect(computeCost('claude-opus-4-7', 0, 1_000_000)).toBe(75.0);
  });

  it('computes blended cost for claude-opus-4-7', () => {
    expect(computeCost('claude-opus-4-7', 500_000, 500_000)).toBe(45.0);
  });

  it('returns 0 for null model', () => {
    expect(computeCost(null, 100, 100)).toBe(0);
  });

  it('returns 0 for unknown model', () => {
    expect(computeCost('unknown-model', 100, 100)).toBe(0);
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
});
