import { readFileSync, statSync } from 'node:fs';
import type { ArtifactChecksRecoveryRequest } from '@autopod/shared';
import type { Command } from 'commander';
import type { AutopodClient } from '../api/client.js';
import { withJsonOutput } from '../output/json.js';
import { resolvePodId } from '../utils/id-resolver.js';

export function registerArtifactChecksRecoveryCommand(
  program: Command,
  getClient: () => AutopodClient,
) {
  program
    .command('recover-artifact-checks <id>')
    .description(
      'Inspect or explicitly select checks on retained artifact contents; no coding or delivery',
    )
    .option('--apply', 'Select the exact saved request; acknowledgement is not a check pass')
    .option('--reconcile', 'Observe the same saved request without replaying uncertain mutations')
    .option('--request <file>', 'Exact saved JSON request, maximum 128 KiB')
    .option('--json', 'Output JSON')
    .action(
      async (
        id: string,
        opts: { apply?: boolean; reconcile?: boolean; request?: string; json?: boolean },
      ) => {
        if (opts.apply && opts.reconcile) throw new Error('Choose --apply or --reconcile.');
        if (Boolean(opts.apply || opts.reconcile) !== Boolean(opts.request))
          throw new Error('Mutation requires --request and exactly one of --apply/--reconcile.');
        let input: ArtifactChecksRecoveryRequest | undefined;
        if (opts.request) {
          const info = statSync(opts.request);
          if (!info.isFile() || info.size > 131072)
            throw new Error('Request must be a regular JSON file up to 128 KiB.');
          const bytes = readFileSync(opts.request);
          if (bytes.length > 131072) throw new Error('Request exceeds 128 KiB.');
          const parsed: unknown = JSON.parse(bytes.toString('utf8'));
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
            throw new Error('Request must be a JSON object.');
          input = parsed as ArtifactChecksRecoveryRequest;
        }
        const client = getClient();
        const podId = await resolvePodId(client, id);
        // No generated ID, fallback to Resume, or automatic network retry.
        const result = input
          ? await client.recoverArtifactChecks(podId, input, Boolean(opts.reconcile))
          : await client.inspectArtifactChecksRecovery(podId);
        withJsonOutput(opts, result, (value) => console.log(JSON.stringify(value, null, 2)));
      },
    );
}
