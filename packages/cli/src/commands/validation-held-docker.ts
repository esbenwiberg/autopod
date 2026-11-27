import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { validationHeldStopRequestSchema } from '@autopod/shared';
import type { Command } from 'commander';
import { z } from 'zod';
import type { AutopodClient } from '../api/client.js';
import { saveRetainedRequest } from './retained-cleanup.js';

const journal = z.strictObject({
  version: z.literal(1),
  podId: z.string(),
  daemon: z.string(),
  request: validationHeldStopRequestSchema,
});
export function registerValidationHeldDockerCommand(
  program: Command,
  getClient: () => AutopodClient,
) {
  program
    .command('stop-validation-held <pod>')
    .description(
      'Preview exact Stop and retain for validation-held local Docker (read-only by default)',
    )
    .option('--apply', 'Submit one exactly reviewed human Stop request')
    .option('--observe', 'Read the exact receipt without replaying effects')
    .option('--reconcile', 'Reconcile only the original saved request and actor')
    .option(
      '--request-file <path>',
      'New operator journal for apply; original journal for observation/reconciliation',
    )
    .option('--request-id <id>', 'Stable request key for apply or observation')
    .option('--daemon-identity <url>', 'Exact daemon identity from preview')
    .option('--generation <number>', 'Reviewed lifecycle generation')
    .option('--binding <sha256>', 'Reviewed exact selection')
    .option('--reason <text>', 'Meaningful human reason')
    .option('--json', 'Print JSON')
    .action(async (podId, opts) => {
      if ([opts.apply, opts.observe, opts.reconcile].filter(Boolean).length > 1)
        throw new Error('Choose one action.');
      const client = getClient(),
        daemon = client.cleanupDaemonIdentity;
      let request: z.infer<typeof validationHeldStopRequestSchema> | string | undefined;
      if (opts.apply) {
        if (
          !opts.requestFile ||
          opts.daemonIdentity !== daemon ||
          !/^[1-9][0-9]*$/.test(opts.generation ?? '')
        )
          throw new Error(
            'Apply requires a new request file, matching daemon identity and reviewed generation/binding.',
          );
        request = validationHeldStopRequestSchema.parse({
          requestKey: opts.requestId,
          expectedGeneration: Number(opts.generation),
          expectedBinding: opts.binding,
          mode: 'stop-retain',
          reason: opts.reason,
        });
        await saveRetainedRequest(resolve(opts.requestFile), {
          version: 1,
          daemon,
          podId,
          request,
        });
      } else if (opts.observe || opts.reconcile) {
        if (opts.requestFile && !opts.requestId) {
          const saved = journal.parse(
            JSON.parse(await readFile(resolve(opts.requestFile), 'utf8')),
          );
          if (saved.podId !== podId || saved.daemon !== daemon)
            throw new Error('Journal daemon/pod mismatch.');
          request = opts.observe ? saved.request.requestKey : saved.request;
        } else if (opts.observe && !opts.requestFile && opts.requestId) request = opts.requestId;
        else
          throw new Error(
            'Reconcile requires the original request file; observe requires the file or exact key.',
          );
      } else if (
        [
          opts.requestFile,
          opts.requestId,
          opts.daemonIdentity,
          opts.generation,
          opts.binding,
          opts.reason,
        ].some((v) => v !== undefined)
      )
        throw new Error('Default preview does not accept request or confirmation arguments.');
      try {
        const result = await client.validationHeldDocker(podId, request);
        console.log(
          JSON.stringify(
            {
              ...result,
              daemon,
              next:
                result.state === 'stopped'
                  ? ['ap', 'cleanup-retained', podId, '--json']
                  : 'Observe the same request after uncertainty. Never substitute Kill or use a new key.',
            },
            null,
            opts.json ? undefined : 2,
          ),
        );
        if (result.state === 'unknown' || result.state === 'blocked') process.exitCode = 1;
      } catch (e) {
        console.log(
          JSON.stringify({
            state: 'unknown',
            podId,
            daemon,
            requestKey: typeof request === 'object' ? request.requestKey : request,
            message: e instanceof Error ? e.message : 'Observation unavailable',
            next: 'Observe the exact saved key; do not automatically repeat a write or fall back to Kill.',
          }),
        );
        process.exitCode = 1;
      }
    });
}
