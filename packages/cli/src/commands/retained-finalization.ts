import type { RetainedFinalizationReceipt, RetainedFinalizationRequest } from '@autopod/shared';
import type { Command } from 'commander';
import type { AutopodClient } from '../api/client.js';
import { withJsonOutput } from '../output/json.js';
import { resolvePodId } from '../utils/id-resolver.js';

interface FinalizationOptions {
  apply?: boolean;
  stopRetain?: boolean;
  completeMerged?: boolean;
  requestKey?: string;
  generation?: string;
  binding?: string;
  reason?: string;
  json?: boolean;
}

function selection(opts: FinalizationOptions): RetainedFinalizationRequest | undefined {
  const mutationFields = [
    opts.stopRetain,
    opts.completeMerged,
    opts.requestKey,
    opts.generation,
    opts.binding,
    opts.reason,
  ];
  if (!opts.apply) {
    if (mutationFields.some((value) => value !== undefined)) {
      throw new Error('Mutation fields require --apply; omit them for read-only inspection.');
    }
    return undefined;
  }
  if (Boolean(opts.stopRetain) === Boolean(opts.completeMerged)) {
    throw new Error('--apply requires exactly one of --stop-retain or --complete-merged.');
  }
  const { requestKey, generation, binding, reason } = opts;
  if (
    requestKey === undefined ||
    generation === undefined ||
    binding === undefined ||
    reason === undefined
  ) {
    throw new Error('--apply requires --request-key, --generation, --binding and --reason.');
  }
  if (!/^[a-zA-Z0-9-]{1,64}$/.test(requestKey)) {
    throw new Error('--request-key must contain 1–64 alphanumeric or hyphen characters.');
  }
  if (!/^[1-9][0-9]*$/.test(generation) || !Number.isSafeInteger(Number(generation))) {
    throw new Error('--generation must be a positive safe integer from inspection.');
  }
  if (!/^[a-f0-9]{64}$/.test(binding)) {
    throw new Error('--binding must be the exact inspected SHA256 (64 lowercase hex characters).');
  }
  if (reason.trim().length < 10 || reason.length > 4000) {
    throw new Error('--reason must contain 10–4000 characters with a meaningful explanation.');
  }
  return {
    requestKey,
    expectedGeneration: Number(generation),
    expectedBinding: binding,
    mode: opts.stopRetain ? 'stop-retain' : 'complete-merged',
    reason,
  };
}

function renderReceipt(receipt: RetainedFinalizationReceipt): void {
  console.log(`${receipt.podId}: ${receipt.state} (${receipt.request.mode})`);
  console.log(receipt.message);
  if (receipt.state === 'pending') {
    console.log('Pending is not finalized; no terminal outcome is claimed.');
  } else if (receipt.request.mode === 'stop-retain') {
    console.log('Stopped with resources retained; this does not claim completed delivery.');
  } else {
    console.log('External merged delivery finalized by the daemon; no merge was requested.');
  }
  console.log(`Request key: ${receipt.request.requestKey}`);
  console.log(`Saved generation: ${receipt.request.expectedGeneration}`);
  console.log(`Saved binding: ${receipt.request.expectedBinding}`);
  console.log(`Saved reason: ${receipt.request.reason}`);
}

export function registerRetainedFinalizationCommand(
  program: Command,
  getClient: () => AutopodClient,
): void {
  program
    .command('finalize-retained <id>')
    .description(
      'Inspect retained finalization; explicitly stop and retain or finalize external merged delivery',
    )
    .option('--apply', 'Submit the exact inspected selection (no automatic preview or retry)')
    .option('--stop-retain', 'Stop execution while retaining resources; do not claim completion')
    .option('--complete-merged', 'Complete only with fresh daemon-verified external merge proof')
    .option('--request-key <key>', 'Stable request key; manual replay requires an identical body')
    .option('--generation <number>', 'Exact inspected lifecycle generation')
    .option('--binding <sha256>', 'Exact inspected resource/source/custody binding')
    .option('--reason <text>', 'Human reason (10–4000 characters)')
    .option('--json', 'Output only the daemon view or receipt as JSON')
    .action(async (id: string, opts: FinalizationOptions) => {
      // Validate even explicitly empty fields before ID resolution or client creation.
      const request = selection(opts);
      const client = getClient();
      const podId = await resolvePodId(client, id);
      if (request) {
        const receipt = await client.finalizeRetained(podId, request);
        withJsonOutput(opts, receipt, renderReceipt);
      } else {
        const view = await client.inspectRetainedFinalization(podId);
        withJsonOutput(opts, view, (value) => {
          console.log(`${value.podId}: ${value.status} (read-only inspection)`);
          console.log(`Generation: ${value.generation}\nBinding: ${value.binding}`);
          console.log(`Stop and retain eligible: ${value.canStop}`);
          console.log(`Complete merged eligible: ${value.canCompleteMerged}`);
          for (const blocker of value.blockers) console.log(`Blocked: ${blocker}`);
          for (const owner of value.custody) console.log(`Custody: ${owner.kind} ${owner.id}`);
          if (value.operation) renderReceipt(value.operation);
          console.log(
            'To submit, supply --apply, exactly one mode, --request-key, --generation, --binding and --reason.',
          );
        });
      }
      if (!opts.json) {
        console.log(
          'Resources remain retained; source-recovery owners may remain held. The daemon independently enforces eligibility.',
        );
        console.log('No destructive cleanup, push, merge or worker restart is requested.');
        console.log(
          'After an uncertain response, replay manually with the same key and identical body; never substitute a new binding or key.',
        );
      }
    });
}
