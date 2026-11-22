import { type BudgetContinuationResponse, describeTaskBudgetUsage } from '@autopod/shared';
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

/**
 * Commander option parser for `--token-budget`. Commander replaces a `null` parse result with an
 * empty string, so `off` stays a literal marker here and becomes `null` in the launch request.
 */
export function parseTokenBudgetOption(value: string): number | 'off' {
  return parseTokenBudget(value) ?? 'off';
}

/** Printed once a budget pause is approved; validation then runs in the background. */
export function budgetContinuedMessage(podId: string): string {
  return `Budget extension approved; validation started in the background. Follow with: ap status ${podId} or ap logs ${podId} -f`;
}

export function registerBudgetCommand(program: Command, getClient: () => AutopodClient): void {
  program
    .command('budget <pod> <tokens-or-off>')
    .description('Raise or remove a task token limit, including linked repair pods')
    .option(
      '--continue',
      'Also approve a pod paused on its token budget; validation starts in the background',
    )
    .option('--resume', 'Also resume a paused or budget-limited native Goal')
    .option('--json', 'Output JSON')
    .addHelpText(
      'after',
      '\nA pod paused on its token budget stays paused until approved. Raise the limit and continue in one step:\n  ap budget <pod> <tokens> --continue',
    )
    .action(
      async (
        pod: string,
        value: string,
        opts: { continue?: boolean; resume?: boolean; json?: boolean },
      ) => {
        const budget = parseTokenBudget(value);
        const client = getClient();
        const id = await resolvePodId(client, pod);
        const session = await client.getSession(id);
        const budgetPaused = session.status === 'paused' && session.pauseReason === 'budget';
        // Check before raising so a mistaken --continue changes nothing.
        if (opts.continue && !budgetPaused)
          throw new Error(
            `Pod ${id} is not paused on its token budget (status: ${session.status}); nothing to continue. Omit --continue to only change the limit.`,
          );
        const current = await client.getTaskExecution(id);
        const updated = await client.raiseTaskBudget(id, budget, current.tokenBudget);
        if (opts.resume) {
          const goal = await client.getGoal(id);
          if (goal.executionStopped && !['achieved', 'cancelled'].includes(goal.state))
            await client.controlGoal(id, goal.revision, 'resume');
        }
        let continued: BudgetContinuationResponse | undefined;
        if (opts.continue) continued = await client.continueBudget(id);
        withJsonOutput(
          opts,
          continued ? { ...updated, continuation: continued } : updated,
          (task) => {
            console.log(`Task token limit: ${task.tokenBudget ?? 'off'}`);
            // Usage is compared with the limit on the budget-counted figure, not the raw total.
            if (typeof task.recordedInputTokens === 'number')
              console.log(`Task tokens: ${describeTaskBudgetUsage(task, task.tokenBudget)}`);
            if (continued) console.log(budgetContinuedMessage(id));
            else if (budgetPaused && !opts.resume)
              console.log(
                `Pod ${id} is still paused on its token budget. Approve with: ap budget ${id} <tokens> --continue (or ap resume ${id})`,
              );
          },
        );
      },
    );
}
