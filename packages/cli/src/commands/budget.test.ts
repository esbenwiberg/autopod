import { Command } from 'commander';
import { afterEach, expect, it, vi } from 'vitest';
import type { AutopodClient } from '../api/client.js';
import { parseTokenBudget, registerBudgetCommand } from './budget.js';
import { buildLaunchRequest } from './launch-request.js';

afterEach(() => vi.restoreAllMocks());
it('keeps budgets absent by default and honors an explicit off override', async () => {
  const lookup = async () => [];
  const request = await buildLaunchRequest({}, lookup, { repositoryId: 'repo-a', task: 'Work' });
  expect(request.overrides?.workflow?.tokenBudget).toBeUndefined();
  expect(
    (
      await buildLaunchRequest({ tokenBudget: null, overrideConfig: true }, lookup, {
        repositoryId: 'repo-a',
        task: 'Work',
      })
    ).overrides?.workflow?.tokenBudget,
  ).toBeNull();
  expect(parseTokenBudget('off')).toBeNull();
  expect(parseTokenBudget('100')).toBe(100);
  for (const bad of ['0', '-1', '1.5', 'wat', '9007199254740992'])
    expect(() => parseTokenBudget(bad)).toThrow();
});
it('shows budget-counted usage beside the raised limit', async () => {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const updated = {
    tokenBudget: 3000000,
    recordedInputTokens: 1850000,
    recordedOutputTokens: 38511,
    recordedTotalTokens: 1888511,
    recordedCachedInputTokens: 1804032,
    budgetCountedTokens: 264883,
  };
  const client = {
    getTaskExecution: vi.fn(async () => ({ tokenBudget: 2000000 })),
    raiseTaskBudget: vi.fn(async () => updated),
  };
  const program = new Command().exitOverride();
  registerBudgetCommand(program, () => client as unknown as AutopodClient);
  await program.parseAsync(['budget', '12345678', '3000000'], { from: 'user' });
  expect(log.mock.calls.flat()).toEqual([
    'Task token limit: 3000000',
    'Task tokens: 264883/3000000 budget-counted tokens used; 1888511 recorded incl. 1804032 cache reads at 0.1x',
  ]);
});
it.each([false, true])('removes the current task limit with explicit resume=%s', async (resume) => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  const client = {
    getTaskExecution: vi.fn(async () => ({ tokenBudget: 100 })),
    raiseTaskBudget: vi.fn(async () => ({ tokenBudget: null })),
    getGoal: vi.fn(async () => ({ revision: 7, state: 'budget_limited', executionStopped: true })),
    controlGoal: vi.fn(async () => ({})),
  };
  const program = new Command().exitOverride();
  registerBudgetCommand(program, () => client as unknown as AutopodClient);
  await program.parseAsync(['budget', '12345678', 'off', ...(resume ? ['--resume'] : [])], {
    from: 'user',
  });
  expect(client.raiseTaskBudget).toHaveBeenCalledExactlyOnceWith('12345678', null, 100);
  expect(client.controlGoal).toHaveBeenCalledTimes(resume ? 1 : 0);
});
