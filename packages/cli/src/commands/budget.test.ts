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
