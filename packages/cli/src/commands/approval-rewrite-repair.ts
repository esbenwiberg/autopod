import type { Command } from 'commander';
import type { AutopodClient } from '../api/client.js';
import { withJsonOutput } from '../output/json.js';

/** Dedicated transport deliberately has no fallback to approve/resume/continuation. */
export function registerApprovalRewriteRepairCommand(
  program: Command,
  getClient: () => AutopodClient,
) {
  program
    .command('approval-rewrite-repair <pod-id>')
    .description(
      'Inspect or prepare/select repair of an exact failed approval rewrite; never grant retry or delivery',
    )
    .option('--prepare', 'Prepare an independent checkout only')
    .option('--check', 'Select an exact committed prepared candidate for checks only')
    .option('--request-id <id>', 'Stable repair request ID')
    .option('--rewrite-id <id>', 'Exact owning rewrite ID')
    .option('--failed-dispatch-id <id>', 'Exact failed immutable validation dispatch')
    .option('--generation <number>', 'Exact failed lifecycle generation')
    .option('--result-hash <sha256>', 'Exact failed result hash')
    .option('--head <sha>', 'Exact failed selected host HEAD (prepare only)')
    .option('--candidate-head <sha>', 'Exact clean committed repair HEAD (check only)')
    .option('--reason <text>', 'Human reason (10–4000 characters)')
    .option('--json', 'Output JSON')
    .action(
      async (
        podId: string,
        opts: {
          prepare?: boolean;
          check?: boolean;
          requestId?: string;
          rewriteId?: string;
          failedDispatchId?: string;
          generation?: string;
          resultHash?: string;
          head?: string;
          candidateHead?: string;
          reason?: string;
          json?: boolean;
        },
      ) => {
        const mutation = Object.entries(opts).some(
          ([key, value]) => key !== 'json' && value !== undefined,
        );
        if (mutation) {
          if (Boolean(opts.prepare) === Boolean(opts.check))
            throw new Error('Choose exactly --prepare or --check.');
          if (
            !opts.requestId ||
            !/^[a-zA-Z0-9-]{1,64}$/.test(opts.requestId) ||
            !opts.rewriteId ||
            !opts.failedDispatchId ||
            !/^[1-9][0-9]*$/.test(opts.generation ?? '') ||
            !Number.isSafeInteger(Number(opts.generation)) ||
            !/^[a-f0-9]{64}$/.test(opts.resultHash ?? '') ||
            !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(
              (opts.prepare ? opts.head : opts.candidateHead) ?? '',
            ) ||
            (opts.prepare ? opts.candidateHead !== undefined : opts.head !== undefined) ||
            !opts.reason ||
            opts.reason.trim().length < 10 ||
            opts.reason.length > 4000
          )
            throw new Error(
              'Supply exact request/rewrite/dispatch IDs, generation, failed result hash, source HEAD and meaningful reason.',
            );
        }
        const client = getClient();
        // Full ID is intentional: no prefix resolution or inferred incident identity.
        const identity = {
          rewriteId: opts.rewriteId!,
          failedDispatchId: opts.failedDispatchId!,
          expectedGeneration: Number(opts.generation),
          expectedResultHash: opts.resultHash!,
          reason: opts.reason!,
        };
        const result = opts.prepare
          ? await client.prepareRewriteRepair(podId, {
              ...identity,
              id: opts.requestId!,
              checkpointHead: opts.head!,
            })
          : opts.check
            ? await client.checkRewriteRepair(podId, opts.requestId!, {
                ...identity,
                candidateHead: opts.candidateHead!,
              })
            : await client.getRewriteRepairs(podId);
        withJsonOutput(opts, result, (value) => console.log(JSON.stringify(value, null, 2)));
      },
    );
}
