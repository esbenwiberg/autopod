import type { PodGoal } from '@autopod/shared';
import type { Command } from 'commander';
import type { AutopodClient } from '../api/client.js';
import { withJsonOutput } from '../output/json.js';
import { resolvePodId } from '../utils/id-resolver.js';

function display(goal: PodGoal) {
  console.log(
    `${goal.state}${goal.controlIntent ? ` (${goal.controlIntent} requested)` : ''}: ${goal.objective}`,
  );
  console.log(
    `${goal.observedTokens} native tokens, including goal evaluation · revision ${goal.revision}`,
  );
  if (goal.reason) console.log(goal.reason);
  if (!goal.executionStopped) console.log('Native process termination is not yet confirmed.');
}

export function registerGoalCommands(program: Command, getClient: () => AutopodClient): void {
  const command = program.command('goal').description('Inspect and control a pod’s native Goal');
  command
    .command('show <pod>')
    .option('--json', 'Output JSON')
    .action(async (pod: string, opts: { json?: boolean }) => {
      const client = getClient();
      withJsonOutput(opts, await client.getGoal(await resolvePodId(client, pod)), display);
    });
  for (const intent of ['pause', 'resume', 'cancel'] as const) {
    command
      .command(`${intent} <pod>`)
      .option('--json', 'Output JSON')
      .action(async (pod: string, opts: { json?: boolean }) => {
        const client = getClient();
        const id = await resolvePodId(client, pod);
        const current = await client.getGoal(id);
        const updated = await client.controlGoal(id, current.revision, intent);
        withJsonOutput(opts, updated, display);
      });
  }
}
