import type { Command } from 'commander';
import type { AutopodClient } from '../api/client.js';
import { withJsonOutput } from '../output/json.js';

export type GuardFlags = { expectedTarget?: string; actor?: string; json?: boolean };
export async function runGuardedOperatorAction(
  client: AutopodClient,
  id: string,
  action: 'reply' | 'approve' | 'nudge',
  flags: GuardFlags,
  message?: string,
): Promise<void> {
  const expectedTarget = flags.expectedTarget;
  const actor = flags.actor;
  if (
    typeof expectedTarget !== 'string' ||
    !/^[a-f0-9]{64}$/.test(expectedTarget) ||
    typeof actor !== 'string' ||
    !/^[a-zA-Z0-9_-]{1,128}$/.test(actor)
  )
    throw new Error(
      'Guarded actions require --expected-target from operator-target and --actor <session-id>',
    );
  const receipt = await client.guardedOperatorAction(id, {
    action,
    expectedTarget,
    actor,
    ...(message !== undefined ? { message } : {}),
  });
  withJsonOutput(flags, receipt, () =>
    console.log(`Guarded ${action} returned; inspect recorded state for delivery outcome.`),
  );
}
export function registerOperatorTargetCommand(
  program: Command,
  getClient: () => AutopodClient,
): void {
  program
    .command('operator-target <id>')
    .description(
      'Inspect the exact recorded question/validation identity for guarded automation; no approval granted',
    )
    .option('--json', 'Output JSON')
    .action(async (id: string, opts: { json?: boolean }) => {
      const target = await getClient().getOperatorTarget(id);
      withJsonOutput(opts, target, (value) => console.log(JSON.stringify(value, null, 2)));
    });
}
