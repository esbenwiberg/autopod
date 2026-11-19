import type { Command } from 'commander';
import type { AutopodClient } from '../api/client.js';

export function registerOrchestrationCommands(program: Command, getClient: () => AutopodClient) {
  const group = program
    .command('orchestration')
    .description('Operate an enrolled controller-managed task');
  const ops = {
    status: 'Inspect the task and its workers without starting anything',
    start: 'Start the enrolled task; the daemon selects and launches workers',
    cancel: 'Request cancellation (not proof of worker exit)',
    cleanup: 'Remove canceled workers after their exits are observed',
  } as const;
  for (const op of Object.keys(ops) as (keyof typeof ops)[]) {
    group
      .command(`${op} <slot>`)
      .description(ops[op])
      .action(async (slot: string) => {
        const result = await getClient().operatorRun(op, slot);
        console.log(JSON.stringify(result, null, 2));
      });
  }
}
