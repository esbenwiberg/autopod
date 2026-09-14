import type { PodGoal } from '@autopod/shared';
import { Command } from 'commander';
import { afterEach, expect, it, vi } from 'vitest';
import type { AutopodClient } from '../api/client.js';
import { registerGoalCommands } from './goal.js';

afterEach(() => vi.restoreAllMocks());
it('uses the displayed native Goal revision and never turns an uncertain control into a retry', async () => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  const goal = {
    podId: '12345678',
    revision: 7,
    state: 'paused',
    objective: 'Tests pass',
    observedTokens: 40,
    executionStopped: true,
  } as PodGoal;
  const getGoal = vi.fn(async () => goal);
  const controlGoal = vi.fn(async () => {
    throw new Error('Response uncertain');
  });
  const program = new Command().exitOverride();
  registerGoalCommands(program, () => ({ getGoal, controlGoal }) as unknown as AutopodClient);
  await expect(
    program.parseAsync(['goal', 'resume', '12345678'], { from: 'user' }),
  ).rejects.toThrow('Response uncertain');
  expect(getGoal).toHaveBeenCalledOnce();
  expect(controlGoal).toHaveBeenCalledExactlyOnceWith('12345678', 7, 'resume');
});
