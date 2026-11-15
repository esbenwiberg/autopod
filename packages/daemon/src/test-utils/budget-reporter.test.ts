import { expect, it } from 'vitest';
import { type BudgetRecord, formatBudgetSummary } from './budget-reporter.js';

const record = (
  name: string,
  duration: number,
  timeout = 5000,
  state = 'passed',
): BudgetRecord => ({
  name,
  state: state as BudgetRecord['state'],
  startTime: 0,
  duration,
  timeout,
});

it('prints totals, every failure and the tests closest to their own deadline', () => {
  const lines = formatBudgetSummary([
    record('a.test.ts > fast', 100),
    record('a.test.ts > half', 2600),
    record('b.test.ts > long but budgeted', 9000, 30_000),
    record('b.test.ts > near', 4900, 5000),
    {
      ...record('c.test.ts > timed out', 5003, 5000, 'failed'),
      error: 'Test timed out in 5000ms.',
    },
    record('c.test.ts > skipped', 0, 5000, 'skipped'),
  ]);
  expect(lines).toEqual([
    '[test-budget] tests: 4 passed, 1 failed, 1 skipped',
    '[test-budget] FAILED c.test.ts > timed out (5.0s of 5.0s): Test timed out in 5000ms.',
    '[test-budget] 3 test(s) used >= 50% of their timeout:',
    '[test-budget]   100% 5.0s/5.0s c.test.ts > timed out',
    '[test-budget]   98% 4.9s/5.0s b.test.ts > near',
    '[test-budget]   52% 2.6s/5.0s a.test.ts > half',
  ]);
});

it('bounds the pressure list', () => {
  const records = Array.from({ length: 4 }, (_, i) => record(`t${i}`, 4000 + i));
  expect(formatBudgetSummary(records, 2).slice(-3)).toEqual([
    '[test-budget]   80% 4.0s/5.0s t3',
    '[test-budget]   80% 4.0s/5.0s t2',
    '[test-budget]   ... 2 more',
  ]);
});
