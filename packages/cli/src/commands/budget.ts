import type { Command } from 'commander';
import type { AutopodClient } from '../api/client.js';
import { withJsonOutput } from '../output/json.js';
import { resolvePodId } from '../utils/id-resolver.js';

export function parseTokenBudget(value: string): number | null {
  if (value === 'off') return null;
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value)))
    throw new Error('Token budget must be a positive integer or off.');
  return Number(value);
}

export function registerBudgetCommand(program: Command, getClient: () => AutopodClient): void {
  program
    .command('budget <pod> <tokens-or-off>')
    .description('Raise or remove a task token limit, including linked repair pods')
    .option('--resume', 'Also resume a paused or budget-limited native Goal')
    .option('--json', 'Output JSON')
    .action(async (pod: string, value: string, opts: { resume?: boolean; json?: boolean }) => {
      const budget = parseTokenBudget(value);
      const client = getClient();
      const id = await resolvePodId(client, pod);
      const current = await client.getTaskExecution(id);
      const updated = await client.raiseTaskBudget(id, budget, current.tokenBudget);
      if (opts.resume) {
        const goal = await client.getGoal(id);
        if (goal.executionStopped && !['achieved', 'cancelled'].includes(goal.state))
          await client.controlGoal(id, goal.revision, 'resume');
      }
      withJsonOutput(opts, updated, (task) =>
        console.log(`Task token limit: ${task.tokenBudget ?? 'off'}`),
      );
    });
}
