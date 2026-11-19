import type { Command } from 'commander';
import type { AutopodClient } from '../api/client.js';
import { withJsonOutput } from '../output/json.js';

export function registerRewriteAbandonmentCommand(
  program: Command,
  getClient: () => AutopodClient,
) {
  program
    .command('abandon-rewrite <pod-id>')
    .description(
      'Inspect or explicitly discard an idle sandbox approval rewrite, delete owned resources and remove the pod',
    )
    .option('--apply', 'Apply the exact inspected discard selection; never auto-preview or retry')
    .option(
      '--request-id <id>',
      'Stable deletion request ID; reuse only to observe/reconcile this exact request',
    )
    .option('--generation <number>', 'Exact inspected lifecycle generation')
    .option('--binding <sha256>', 'Exact inspected source/resource/validation binding')
    .option('--reason <text>', 'Human reason (10–4000 characters)')
    .option('--acknowledge-data-loss', 'Permanently discard unpreserved files and reports')
    .option('--json', 'Output JSON')
    .action(
      async (
        podId: string,
        opts: {
          apply?: boolean;
          requestId?: string;
          generation?: string;
          binding?: string;
          reason?: string;
          acknowledgeDataLoss?: boolean;
          json?: boolean;
        },
      ) => {
        const mutation = Object.keys(opts).some((key) => key !== 'json');
        if (
          mutation &&
          (!opts.apply ||
            !opts.acknowledgeDataLoss ||
            !/^[a-zA-Z0-9-]{1,64}$/.test(opts.requestId ?? '') ||
            !/^[1-9][0-9]*$/.test(opts.generation ?? '') ||
            !Number.isSafeInteger(Number(opts.generation)) ||
            !/^[a-f0-9]{64}$/.test(opts.binding ?? '') ||
            !opts.reason ||
            opts.reason.trim().length < 10 ||
            opts.reason.length > 4000)
        )
          throw new Error(
            'Apply requires exact --request-id, --generation, --binding, meaningful --reason and --acknowledge-data-loss.',
          );
        const client = getClient();
        const result = opts.apply
          ? await client.abandonRewrite(podId, {
              id: opts.requestId!,
              expectedGeneration: Number(opts.generation),
              expectedBinding: opts.binding!,
              reason: opts.reason!,
              acknowledgeDataLoss: true,
            })
          : await client.getRewriteAbandonment(podId);
        withJsonOutput(opts, result, (value) => console.log(JSON.stringify(value, null, 2)));
      },
    );
}
