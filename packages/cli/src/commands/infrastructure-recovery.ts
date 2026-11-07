import { readFileSync, statSync } from 'node:fs';
import type { InfrastructureRecoveryRequest } from '@autopod/shared';
import type { Command } from 'commander';
import type { AutopodClient } from '../api/client.js';
import { withJsonOutput } from '../output/json.js';
import { resolvePodId } from '../utils/id-resolver.js';

export function registerInfrastructureRecoveryCommand(
  program: Command,
  getClient: () => AutopodClient,
) {
  program
    .command('recover-infrastructure <id>')
    .description(
      'Preserve and quiesce a settled failed task; explicitly select checks-only or one coding repair',
    )
    .option('--apply', 'Admit the exact inspected JSON request; not passing checks or delivery')
    .option(
      '--reconcile',
      'Observe/reconcile the same request after an uncertain stop; never replay a dispatched stop',
    )
    .option(
      '--request <file>',
      'Exact saved request JSON (up to 128 KiB); include mode, source/report identity and diagnosis',
    )
    .option(
      '--preview-execution <profile>',
      'Read-only software/resource preview with original authority frozen',
    )
    .option('--json', 'Output JSON')
    .action(
      async (
        id: string,
        opts: {
          apply?: boolean;
          reconcile?: boolean;
          request?: string;
          previewExecution?: string;
          json?: boolean;
        },
      ) => {
        if (opts.apply && opts.reconcile) throw new Error('Choose --apply or --reconcile.');
        if (Boolean(opts.apply || opts.reconcile) !== Boolean(opts.request))
          throw new Error('Mutation requires --request and exactly one of --apply/--reconcile.');
        if (opts.previewExecution && (opts.apply || opts.reconcile || opts.request))
          throw new Error('Execution preview is read-only.');
        let request: InfrastructureRecoveryRequest | undefined;
        if (opts.request) {
          const info = statSync(opts.request);
          if (!info.isFile()) throw new Error('Recovery request must be a regular JSON file.');
          if (info.size > 131072) throw new Error('Recovery request exceeds 128 KiB.');
          const bytes = readFileSync(opts.request);
          if (bytes.length > 131072) throw new Error('Recovery request exceeds 128 KiB.');
          const parsed: unknown = JSON.parse(bytes.toString('utf8'));
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
            throw new Error('Recovery request must be a JSON object.');
          request = parsed as InfrastructureRecoveryRequest;
        }
        const client = getClient();
        const podId = await resolvePodId(client, id);
        const result = request
          ? await client.recoverInfrastructure(podId, request, opts.reconcile ?? false)
          : opts.previewExecution
            ? await client.previewRetainedExecution(podId, opts.previewExecution)
            : await client.getCheckpointRecoveries(podId);
        withJsonOutput(opts, result, (value) => console.log(JSON.stringify(value, null, 2)));
      },
    );
}
