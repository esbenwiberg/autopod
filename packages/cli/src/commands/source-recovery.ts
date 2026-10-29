import {
  AutopodError,
  type SourceAdoptionRequest,
  type SourceAdoptionState,
} from '@autopod/shared';
import type { Command } from 'commander';
import { type AutopodClient, DaemonUnreachableError } from '../api/client.js';
import { withJsonOutput } from '../output/json.js';
import { resolvePodId } from '../utils/id-resolver.js';
interface Options {
  requestId?: string;
  generation?: string;
  oldHead?: string;
  head?: string;
  setup?: string;
  reason?: string;
  json?: boolean;
}
function print(state: SourceAdoptionState) {
  console.log(
    `${state.id}: ${state.stage}; validation ${state.validation}${state.error ? `; ${state.error}` : ''}`,
  );
  console.log(`${state.oldHeadSha} → ${state.targetHeadSha}; generation ${state.generation}`);
  console.log(
    'Delivery NOT authorized; original source/reports remain held. No merge, cleanup or retry grant.',
  );
}
export function registerSourceRecoveryCommand(
  program: Command,
  getClient: () => AutopodClient,
): void {
  program
    .command('source-recovery <id>')
    .description(
      'Inspect durable source custody; explicit exact-source adoption runs checks, never delivery',
    )
    .option(
      '--request-id <id>',
      'Stable operation ID, retain and reuse to OBSERVE a lost response, not relaunch',
    )
    .option('--generation <number>', 'Exact original pod lifecycle generation')
    .option('--old-head <sha>', 'Exact original host/container commit')
    .option('--head <sha>', 'Exact repaired remote commit to adopt')
    .option(
      '--setup <command>',
      'Explicit source-bound dependency preparation through validation admission',
    )
    .option('--reason <text>', 'Human reason (10–4000 characters)')
    .option('--json', 'Output JSON')
    .action(async (id: string, opts: Options) => {
      const values = [
        opts.requestId,
        opts.generation,
        opts.oldHead,
        opts.head,
        opts.setup,
        opts.reason,
      ];
      const apply = values.some((value) => value !== undefined);
      if (apply && values.some((value) => !value?.trim()))
        throw new Error(
          'Adoption requires ALL of --request-id, --generation, --old-head, --head, --setup and --reason. Omit all to inspect.',
        );
      if (
        apply &&
        (!/^[1-9][0-9]*$/.test(opts.generation!) || !Number.isSafeInteger(Number(opts.generation)))
      )
        throw new Error('Generation must be a positive safe integer.');
      if (
        apply &&
        (!/^[a-zA-Z0-9-]{1,64}$/.test(opts.requestId!) ||
          !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(opts.oldHead!) ||
          !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(opts.head!) ||
          opts.oldHead === opts.head ||
          opts.reason!.trim().length < 10 ||
          opts.reason!.length > 4000 ||
          opts.setup!.length > 16000)
      )
        throw new Error(
          'Use an exact stable request ID, distinct full lowercase heads and meaningful bounded setup/reason.',
        );
      const client = getClient();
      const podId = await resolvePodId(client, id);
      if (!apply) {
        const list = await client.getSourceAdoptions(podId);
        withJsonOutput(opts, list, (value) => {
          if (!value.operations.length) console.log('No source adoption operations.');
          for (const state of value.operations) print(state);
        });
        return;
      }
      const request: SourceAdoptionRequest = {
        id: opts.requestId!,
        expectedGeneration: Number(opts.generation),
        oldHeadSha: opts.oldHead!,
        targetHeadSha: opts.head!,
        dependencySetupCommand: opts.setup!,
        reason: opts.reason!.trim(),
      };
      try {
        const state = await client.adoptSource(podId, request);
        withJsonOutput(opts, state, print);
      } catch (error) {
        if (error instanceof DaemonUnreachableError || !(error instanceof AutopodError))
          throw new Error(
            `Source request ${request.id} outcome is unknown. Inspect ap source-recovery ${podId}; do not use another request ID or replay a worker. ${error instanceof Error ? error.message : String(error)}`,
          );
        throw error;
      }
    });
}
