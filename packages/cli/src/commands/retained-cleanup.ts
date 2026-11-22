import { link, mkdtemp, open, readFile, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import {
  AutopodError,
  retainedCleanupRequestIdSchema,
  retainedCleanupRequestSchema,
} from '@autopod/shared';
import type { Command } from 'commander';
import { z } from 'zod';
import type { AutopodClient } from '../api/client.js';
import { cleanupPodPath } from '../api/retained-cleanup.js';

const journalSchema = z.strictObject({
  version: z.literal(1),
  daemon: z.string(),
  podId: z.string(),
  request: retainedCleanupRequestSchema,
});

type CleanupOutput =
  | Awaited<ReturnType<AutopodClient['inspectRetainedCleanup']>>
  | Awaited<ReturnType<AutopodClient['submitRetainedCleanup']>>
  | { state: 'unsupported' | 'not_found' | 'uncertain'; podId: string; message: string };

type Options = {
  apply?: boolean;
  reconcile?: boolean;
  observe?: boolean;
  requestFile?: string;
  requestId?: string;
  daemonIdentity?: string;
  planVersion?: string;
  generation?: string;
  binding?: string;
  session?: string;
  reason?: string;
  acknowledgeDataLoss?: boolean;
  json?: boolean;
};

async function saveRequest(path: string, journal: z.infer<typeof journalSchema>) {
  const directory = dirname(path);
  const temp = await mkdtemp(join(directory, '.ap-cleanup-'));
  try {
    const staging = join(temp, 'request.json');
    const file = await open(staging, 'wx', 0o600);
    try {
      await file.writeFile(`${JSON.stringify(journal, null, 2)}\n`);
      await file.sync();
    } finally {
      await file.close();
    }
    // Atomic publication without overwriting another operator request.
    await link(staging, path);
    const parent = await open(directory, 'r');
    try {
      await parent.sync();
    } finally {
      await parent.close();
    }
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

export function registerRetainedCleanupCommand(program: Command, getClient: () => AutopodClient) {
  program
    .command('cleanup-retained <pod>')
    .description(
      'Preview Delete & free resources for retained Docker continuations (read-only by default)',
    )
    .option(
      '--apply',
      'Submit a new, exactly reviewed request once (permanently deletes selected resources)',
    )
    .option('--observe', 'Read the receipt for the exact request without advancing cleanup')
    .option(
      '--reconcile',
      'Resubmit only the exact saved request, explicitly, as the original operator',
    )
    .option(
      '--request-file <path>',
      'Operator-owned journal: new file for apply; existing file for reconcile or observe',
    )
    .option(
      '--request-id <id>',
      'Stable request ID for apply, or exact ID for observe without a file',
    )
    .option('--daemon-identity <url>', 'Exact daemon identity printed by preview')
    .option('--plan-version <version>', 'Reviewed plan version (1)')
    .option('--generation <number>', 'Exact reviewed generation')
    .option('--binding <sha256>', 'Exact reviewed binding')
    .option('--session <id>', 'Exact reviewed task execution ID')
    .option('--reason <text>', 'Meaningful reason (10–4000 characters)')
    .option(
      '--acknowledge-data-loss',
      'Accept permanent loss of the listed resources and unpublished files',
    )
    .option('--json', 'Print the state, exact selection or receipt, and next steps as JSON')
    .action(async (podId: string, opts: Options) => {
      cleanupPodPath(podId);
      if ([opts.apply, opts.observe, opts.reconcile].filter(Boolean).length > 1)
        throw new Error('Apply, observe and reconcile are separate actions.');
      if (
        !opts.apply &&
        [
          opts.daemonIdentity,
          opts.planVersion,
          opts.generation,
          opts.binding,
          opts.session,
          opts.reason,
          opts.acknowledgeDataLoss,
        ].some((v) => v !== undefined)
      )
        throw new Error('Reviewed selection and consent flags are for --apply only.');
      const path = opts.requestFile === undefined ? undefined : resolve(opts.requestFile);
      const client = getClient();
      const daemon = client.cleanupDaemonIdentity;
      let expected: string | z.infer<typeof retainedCleanupRequestSchema> | undefined;
      if (opts.apply) {
        if (
          !opts.requestFile ||
          !path ||
          opts.daemonIdentity !== daemon ||
          opts.planVersion !== '1' ||
          !/^[1-9][0-9]*$/.test(opts.generation ?? '')
        )
          throw new Error(
            'Apply requires a new --request-file, matching --daemon-identity, --plan-version 1 and the exact reviewed selection.',
          );
        expected = retainedCleanupRequestSchema.parse({
          id: opts.requestId,
          expectedGeneration: Number(opts.generation),
          expectedBinding: opts.binding,
          expectedSessionId: opts.session,
          reason: opts.reason,
          acknowledgeDataLoss: opts.acknowledgeDataLoss,
        });
        await saveRequest(path, { version: 1, daemon, podId, request: expected });
      } else if (opts.observe || opts.reconcile) {
        if (opts.requestFile && path && opts.requestId === undefined) {
          const raw: unknown = JSON.parse(await readFile(path, 'utf8'));
          const saved = journalSchema.parse(raw);
          if (
            saved.daemon !== daemon ||
            saved.podId !== podId ||
            (raw as typeof saved).request.reason !== saved.request.reason
          )
            throw new Error(
              'Saved request does not match the selected daemon and pod, or is not normalized.',
            );
          expected = saved.request;
        } else if (opts.observe && path === undefined) {
          expected = retainedCleanupRequestIdSchema.parse(opts.requestId);
        } else {
          throw new Error(
            'Reconcile needs only the original --request-file. Observe needs either --request-file or --request-id.',
          );
        }
      } else if (path !== undefined || opts.requestId !== undefined) {
        throw new Error(
          'Default preview is read-only. Select --observe, --apply or --reconcile to use request arguments.',
        );
      }

      const mutating = opts.apply || opts.reconcile;
      const requestId = typeof expected === 'string' ? expected : expected?.id;
      let result: CleanupOutput;
      try {
        result =
          expected === undefined
            ? await client.inspectRetainedCleanup(podId)
            : typeof expected !== 'string' && mutating
              ? await client.submitRetainedCleanup(podId, expected)
              : await client.observeRetainedCleanup(podId, expected);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Request failed.';
        if (!mutating && error instanceof AutopodError && error.statusCode === 404) {
          result =
            error.code === 'POD_NOT_FOUND'
              ? {
                  state: 'not_found',
                  podId,
                  message: opts.observe
                    ? 'No receipt found for this exact ID. Absence does not prove cleanup failed or succeeded.'
                    : message,
                }
              : {
                  state: 'unsupported',
                  podId,
                  message:
                    'This daemon does not expose the retained cleanup route. Do not fall back to Kill or Delete.',
                };
        } else {
          result = { state: 'uncertain', podId, message };
        }
      }
      const key = 'requestId' in result ? result.requestId : requestId;
      const next =
        key === undefined || result.state === 'deleted'
          ? undefined
          : {
              observe: [
                'ap',
                'cleanup-retained',
                podId,
                '--observe',
                ...(path ? ['--request-file', path] : ['--request-id', key]),
              ],
              ...(path
                ? {
                    reconcile: [
                      'ap',
                      'cleanup-retained',
                      podId,
                      '--reconcile',
                      '--request-file',
                      path,
                    ],
                    guidance:
                      'Observe first. If needed, reconcile only the exact saved request as the original operator. Never use a new key to bypass uncertainty.',
                  }
                : {
                    guidance:
                      'Reconcile only using the original saved request and operator; observation does not retry cleanup.',
                  }),
            };
      console.log(
        JSON.stringify(
          {
            ...result,
            daemon,
            ...(key && { requestId: key }),
            ...(path && { requestFile: path }),
            ...(next && { next }),
          },
          null,
          opts.json ? undefined : 2,
        ),
      );
      if (
        result.state === 'uncertain' ||
        result.state === 'not_found' ||
        result.state === 'unsupported' ||
        (mutating && result.state === 'blocked')
      ) {
        process.exitCode = 1;
      }
    });
}
