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
    getSession: vi.fn(async () => ({ status: 'running', pauseReason: null })),
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
    getSession: vi.fn(async () => ({ status: 'running', pauseReason: null })),
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

function budgetClient(session: { status: string; pauseReason: string | null }) {
  return {
    getSession: vi.fn(async () => session),
    getTaskExecution: vi.fn(async () => ({ tokenBudget: 150000 })),
    raiseTaskBudget: vi.fn(async () => ({ tokenBudget: 600000 })),
    continueBudget: vi.fn(async () => ({
      ok: true,
      action: 'continue-budget',
      budgetExtensionsUsed: 1,
      maxBudgetExtensions: null,
      validation: 'started',
    })),
  };
}
async function runBudget(client: object, args: string[]) {
  const program = new Command().exitOverride();
  registerBudgetCommand(program, () => client as unknown as AutopodClient);
  await program.parseAsync(['budget', '12345678', ...args], { from: 'user' });
}

it('raises the limit and approves a budget pause in one step with --continue', async () => {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const client = budgetClient({ status: 'paused', pauseReason: 'budget' });
  await runBudget(client, ['600000', '--continue']);
  expect(client.raiseTaskBudget).toHaveBeenCalledExactlyOnceWith('12345678', 600000, 150000);
  expect(client.continueBudget).toHaveBeenCalledExactlyOnceWith('12345678');
  expect(client.raiseTaskBudget.mock.invocationCallOrder[0]).toBeLessThan(
    client.continueBudget.mock.invocationCallOrder[0] ?? 0,
  );
  expect(log.mock.calls.flat()).toContain(
    'Budget extension approved; validation started in the background. Follow with: ap status 12345678 or ap logs 12345678 -f',
  );
});

it('refuses --continue before raising when the pod is not budget-paused', async () => {
  const client = budgetClient({ status: 'running', pauseReason: null });
  await expect(runBudget(client, ['600000', '--continue'])).rejects.toThrow(
    'Pod 12345678 is not paused on its token budget (status: running); nothing to continue.',
  );
  expect(client.raiseTaskBudget).not.toHaveBeenCalled();
  expect(client.continueBudget).not.toHaveBeenCalled();
});

it('names the approval command when a raise leaves the pod budget-paused', async () => {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const client = budgetClient({ status: 'paused', pauseReason: 'budget' });
  await runBudget(client, ['600000']);
  expect(client.continueBudget).not.toHaveBeenCalled();
  expect(log.mock.calls.flat()).toContain(
    'Pod 12345678 is still paused on its token budget. Approve with: ap budget 12345678 <tokens> --continue (or ap resume 12345678)',
  );
});

it('documents --continue in help', () => {
  const program = new Command();
  registerBudgetCommand(program, () => ({}) as AutopodClient);
  const budget = program.commands.find((command) => command.name() === 'budget');
  let help = '';
  budget?.configureOutput({ writeOut: (text) => (help += text) });
  budget?.outputHelp();
  expect(help).toContain('--continue');
  expect(help).toContain('ap budget <pod> <tokens> --continue');
});
