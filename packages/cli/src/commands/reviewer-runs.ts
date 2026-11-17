import { reviewerBudgetRevisionRequestSchema } from '@autopod/shared';
import type { Command } from 'commander';
import type { AutopodClient, ReviewerRun } from '../api/client.js';
import { withJsonOutput } from '../output/json.js';
import { resolvePodId } from '../utils/id-resolver.js';

function parseTokenCount(value: string): number {
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)))
    throw new Error('Token counts must be non-negative integers.');
  return Number(value);
}

function describe(run: ReviewerRun): string {
  const usage =
    run.inputTokens === null || run.outputTokens === null
      ? run.usageBasis === 'unknown-accepted'
        ? 'usage unknown (accepted)'
        : 'usage unknown'
      : `${run.inputTokens} in / ${run.outputTokens} out`;
  const flags = [
    run.failureKind,
    run.cleanup !== 'clean' ? `cleanup ${run.cleanup}` : null,
    run.reconciledAt ? `reconciled ${run.reconciledAt}` : null,
  ].filter(Boolean);
  return `${run.requiresReconciliation ? '!' : ' '} ${run.id}  ${run.state}  ${run.runtime}/${run.model}  ${usage}  ${run.createdAt}${flags.length ? `  (${flags.join(', ')})` : ''}`;
}

export function registerReviewerRunsCommand(
  program: Command,
  getClient: () => AutopodClient,
): void {
  program
    .command('reviewer-budget <pod>')
    .description(
      'Inspect or explicitly increase a finite reviewer admission ceiling; preserve cumulative usage',
    )
    .option('--apply', 'Record a human-approved increase; never starts review')
    .option('--limit <n>', 'New finite reviewer token ceiling')
    .option('--request-id <id>', 'Stable idempotent approval request ID')
    .option('--generation <n>', 'Exact inspected lifecycle generation')
    .option('--expected-limit <n>', 'Exact inspected effective reviewer ceiling')
    .option('--evidence-hash <sha256>', 'Exact inspected reviewer usage evidence')
    .option('--reason <text>', 'Reason for this spending increase')
    .option('--ack-usage-retained', 'Acknowledge all existing usage and other limits remain')
    .option('--json', 'Output JSON')
    .action(
      async (
        pod: string,
        opts: {
          apply?: boolean;
          limit?: string;
          requestId?: string;
          generation?: string;
          expectedLimit?: string;
          evidenceHash?: string;
          reason?: string;
          ackUsageRetained?: boolean;
          json?: boolean;
        },
      ) => {
        const client = getClient();
        if (
          !opts.apply &&
          (opts.limit ||
            opts.requestId ||
            opts.generation ||
            opts.expectedLimit ||
            opts.evidenceHash ||
            opts.reason ||
            opts.ackUsageRetained)
        )
          throw new Error('Reviewer allowance changes require explicit --apply.');
        const request = opts.apply
          ? reviewerBudgetRevisionRequestSchema.parse({
              requestId: opts.requestId,
              expectedGeneration:
                opts.generation === undefined ? undefined : parseTokenCount(opts.generation),
              expectedLimit:
                opts.expectedLimit === undefined ? undefined : parseTokenCount(opts.expectedLimit),
              expectedEvidenceHash: opts.evidenceHash,
              limit: opts.limit === undefined ? undefined : parseTokenCount(opts.limit),
              reason: opts.reason,
              acknowledgement: opts.ackUsageRetained ? 'increase-only-usage-retained' : undefined,
            })
          : null;
        const id = await resolvePodId(client, pod);
        if (!request) {
          const view = await client.inspectReviewerBudget(id);
          withJsonOutput(opts, view, (v) =>
            console.log(
              `Reviewer tokens recorded: ${v.recordedTokens}; ceiling: ${v.effectiveLimit ?? 'unlimited'}; generation: ${v.generation}; evidence: ${v.evidenceHash}. Inspection does not start review.`,
            ),
          );
        } else {
          const receipt = await client.reviseReviewerBudget(id, request);
          withJsonOutput(opts, receipt, (r) =>
            console.log(
              `Reviewer ceiling increased ${r.previousLimit} -> ${r.limit}; retained ${r.recordedTokens} recorded tokens. Review not started; all other admission holds remain.`,
            ),
          );
        }
      },
    );

  program
    .command('reviewer-runs <pod>')
    .description('List isolated reviewer runs, or reconcile one whose usage was never measured')
    .option('--reconcile <run-id>', 'Close an uncertain run so review can start again')
    .option('--note <text>', 'Why the run is being reconciled (required with --reconcile)')
    .option('--input-tokens <n>', 'Known input tokens, if the provider reports them')
    .option('--output-tokens <n>', 'Known output tokens, if the provider reports them')
    .option('--json', 'Output JSON')
    .action(
      async (
        pod: string,
        opts: {
          reconcile?: string;
          note?: string;
          inputTokens?: string;
          outputTokens?: string;
          json?: boolean;
        },
      ) => {
        const client = getClient();
        const id = await resolvePodId(client, pod);
        if (!opts.reconcile) {
          if (opts.note || opts.inputTokens || opts.outputTokens)
            throw new Error('--note and token counts require --reconcile <run-id>.');
          const runs = await client.listReviewerRuns(id);
          withJsonOutput(opts, runs, (list) => {
            if (list.length === 0) return console.log('No reviewer runs.');
            for (const run of list) console.log(describe(run));
            const blocked = list.find((run) => run.requiresReconciliation);
            if (blocked)
              console.log(
                `\nReview is blocked. Reconcile with:\n  ap reviewer-runs ${id} --reconcile ${blocked.id} --note "<reason>"`,
              );
          });
          return;
        }
        const note = opts.note?.trim();
        if (!note) throw new Error('--note is required with --reconcile.');
        if ((opts.inputTokens === undefined) !== (opts.outputTokens === undefined))
          throw new Error('--input-tokens and --output-tokens must be supplied together.');
        const updated = await client.reconcileReviewerRun(id, opts.reconcile, {
          note,
          ...(opts.inputTokens !== undefined && opts.outputTokens !== undefined
            ? {
                inputTokens: parseTokenCount(opts.inputTokens),
                outputTokens: parseTokenCount(opts.outputTokens),
              }
            : {}),
        });
        withJsonOutput(opts, updated, (run) => console.log(`Reconciled: ${describe(run)}`));
      },
    );
}
