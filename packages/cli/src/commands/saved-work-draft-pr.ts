import type { Command } from 'commander';
import type { AutopodClient } from '../api/client.js';
import { withJsonOutput } from '../output/json.js';

export function registerSavedWorkDraftPrCommand(program: Command, getClient: () => AutopodClient) {
  program
    .command('draft-pr <pod>')
    .description('Inspect saved work; explicitly prepare and confirm a review-only draft PR')
    .option('--prepare', 'Prepare independent saved-source checkout; does not publish')
    .option(
      '--source <id>',
      'Exact saved source ID from inspection (including older-source selection)',
    )
    .option('--confirm', 'Authorize exact prepared bytes as a draft only; original retained')
    .option('--cancel', 'Cancel only before external admission; keep all source and resources')
    .option(
      '--cancel-preparation',
      'Durably revoke an exact pending preparation, including delayed admission',
    )
    .option('--observe', 'Read-only reconciliation of the same saved request; never publishes')
    .option('--request-id <id>', 'Stable request ID; retain it after network uncertainty')
    .option(
      '--binding <sha256>',
      'Exact inspection binding for prepare, confirmation binding for confirm',
    )
    .option('--json', 'Output daemon preview or separate draft receipt as JSON')
    .action(
      async (
        podId: string,
        opts: {
          prepare?: boolean;
          source?: string;
          confirm?: boolean;
          cancel?: boolean;
          cancelPreparation?: boolean;
          observe?: boolean;
          requestId?: string;
          binding?: string;
          json?: boolean;
        },
      ) => {
        if (
          [opts.prepare, opts.confirm, opts.observe, opts.cancel, opts.cancelPreparation].filter(
            Boolean,
          ).length > 1
        )
          throw new Error('Prepare, confirm and observe are separate explicit actions.');
        if (
          opts.observe &&
          (!/^[a-zA-Z0-9-]{1,64}$/.test(opts.requestId ?? '') ||
            opts.source !== undefined ||
            opts.binding !== undefined)
        )
          throw new Error('--observe requires only the saved --request-id.');
        if (
          !opts.prepare &&
          !opts.confirm &&
          !opts.cancel &&
          !opts.cancelPreparation &&
          !opts.observe &&
          [opts.source, opts.requestId, opts.binding].some((v) => v !== undefined)
        )
          throw new Error(
            'Selection fields require --prepare or --confirm. Inspection is read-only.',
          );
        if (
          (opts.prepare || opts.confirm || opts.cancel || opts.cancelPreparation) &&
          (!/^[a-zA-Z0-9-]{1,64}$/.test(opts.requestId ?? '') ||
            !/^[a-f0-9]{64}$/.test(opts.binding ?? ''))
        )
          throw new Error('Supply --request-id and the exact --binding from the daemon preview.');
        if ((opts.prepare || opts.cancelPreparation) && !opts.source)
          throw new Error('--prepare requires explicit --source from inspection.');
        if ((opts.confirm || opts.cancel) && opts.source !== undefined)
          throw new Error('Confirmation uses the prepared selection; omit --source.');
        const client = getClient();
        try {
          const value = opts.cancelPreparation
            ? await client.cancelSavedWorkDraftPreparation(podId, {
                requestId: opts.requestId ?? '',
                expectedBinding: opts.binding ?? '',
                sourceId: opts.source ?? '',
              })
            : opts.cancel
              ? await client.cancelSavedWorkDraft(podId, {
                  requestId: opts.requestId ?? '',
                  expectedBinding: opts.binding ?? '',
                })
              : opts.observe
                ? await client.observeSavedWorkDraft(podId, opts.requestId!)
                : opts.prepare
                  ? await client.prepareSavedWorkDraft(podId, {
                      requestId: opts.requestId!,
                      expectedBinding: opts.binding!,
                      sourceId: opts.source!,
                    })
                  : opts.confirm
                    ? await client.confirmSavedWorkDraft(podId, {
                        requestId: opts.requestId!,
                        expectedBinding: opts.binding!,
                        draftOnly: true,
                      })
                    : await client.inspectSavedWorkDraft(podId);
          withJsonOutput(opts, value, (result) => {
            console.log(JSON.stringify(result, null, 2));
            console.log(
              'Draft only. Original retained. No approval, passing checks or successful task completion is claimed.',
            );
            console.log(
              `If uncertain, observe the same operation with ap draft-pr ${podId}; do not choose a new request ID or resubmit automatically.`,
            );
          });
        } catch (error) {
          if (opts.prepare || opts.confirm)
            throw new Error(
              `Request ${opts.requestId} outcome unconfirmed: ${error instanceof Error ? error.message : 'request failed'}. Observe with ap draft-pr ${podId} --observe --request-id ${opts.requestId}; do not automatically resubmit.`,
              { cause: error },
            );
          throw error;
        }
      },
    );
}
