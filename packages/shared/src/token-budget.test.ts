import { describe, expect, it } from 'vitest';
import {
  budgetCountedTaskTokens,
  cacheWeightedTokens,
  describeBudgetPause,
  describeTaskBudgetUsage,
} from './token-budget.js';

describe('task token budget weighting', () => {
  it('counts cache reads at a tenth, rounding up, and never exceeds the raw total', () => {
    expect(cacheWeightedTokens(1508607, 1433722)).toBe(218258);
    expect(cacheWeightedTokens(100, 0)).toBe(100);
    expect(cacheWeightedTokens(100, 1)).toBe(100);
    expect(cacheWeightedTokens(100, 500)).toBe(10);
    expect(cacheWeightedTokens(100, -5)).toBe(100);
    expect(cacheWeightedTokens(100, Number.NaN)).toBe(100);
  });

  it('falls back to raw totals for older daemon responses', () => {
    const base = { recordedInputTokens: 30, recordedOutputTokens: 10 };
    expect(budgetCountedTaskTokens(base)).toBe(40);
    expect(budgetCountedTaskTokens({ ...base, recordedTotalTokens: 100 })).toBe(100);
    expect(describeTaskBudgetUsage({ ...base, recordedTotalTokens: 100 }, 80)).toBe(
      '100/80 tokens used',
    );
    expect(describeTaskBudgetUsage(base, null)).toBe('40/no configured limit tokens used');
  });

  it('names discounted cache reads', () => {
    expect(
      describeTaskBudgetUsage(
        {
          recordedInputTokens: 1494436,
          recordedOutputTokens: 14171,
          recordedTotalTokens: 1508607,
          recordedCachedInputTokens: 1433722,
          budgetCountedTokens: 218258,
        },
        200000,
      ),
    ).toBe(
      '218258/200000 budget-counted tokens used; 1508607 recorded incl. 1433722 cache reads at 0.1x',
    );
  });
});

describe('budget pause guidance', () => {
  it('names counted usage and the one-step continue command', () => {
    const task = {
      recordedInputTokens: 300000,
      recordedOutputTokens: 58000,
      budgetCountedTokens: 358000,
      tokenBudget: 150000,
    };
    expect(describeBudgetPause('abcd1234', task)).toBe(
      'Paused: token budget (358000/150000 counted). Run: ap budget abcd1234 <tokens> --continue',
    );
    expect(describeBudgetPause('abcd1234', null)).toBe(
      'Paused: token budget. Run: ap budget abcd1234 <tokens> --continue',
    );
  });
});
