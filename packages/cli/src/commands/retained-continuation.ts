import type { Command } from 'commander';
import { z } from 'zod';
import type { AutopodClient } from '../api/client.js';
import { withJsonOutput } from '../output/json.js';
import { resolvePodId } from '../utils/id-resolver.js';

const sha = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const inspectionResponse = z.object({
  operations: z
    .array(
      z.object({
        id: z.string(),
        prepared: z.unknown(),
        activated: z.unknown(),
        checking: z.unknown(),
        checked: z.unknown(),
        blocked: z.object({ code: z.string() }).nullable(),
      }),
    )
    .optional(),
  inspection: z.object({
    version: z.literal(1),
    mode: z.literal('read_only'),
    generation: z.number().int().positive(),
    status: z.enum(['blocked', 'requires_selection']),
    selection: z
      .object({ expectedGeneration: z.number(), expectedResultHash: z.string() })
      .nullable(),
    infrastructure: z.object({
      state: z.enum(['reported', 'not_checked', 'none_recorded']),
      truncated: z.boolean(),
      needs: z.array(
        z.object({
          id: z.string(),
          owner: z.string().optional(),
          phase: z.string().optional(),
          needs: z.string().optional(),
          truncated: z.boolean(),
        }),
      ),
    }),
    prerequisites: z.object({
      hostPathRecorded: z.boolean(),
      sourcePreservationRecorded: z.boolean(),
      workerSettlementRecorded: z.boolean(),
      pendingDecision: z.boolean(),
      hostSource: z.literal('not_checked'),
      originalFilesAndReports: z.literal('not_checked'),
      resourceStateAndIdentity: z.literal('not_checked'),
      environmentQualification: z.literal('not_checked'),
      retryAdmission: z.literal('not_checked'),
    }),
    checks: z.array(
      z.object({
        id: z.string(),
        state: z.enum(['blocked', 'no_recorded_blocker']),
        code: z.string().nullable(),
        reason: z.string().nullable(),
      }),
    ),
    nextSteps: z.array(z.string()),
  }),
});
// Report text is untrusted; do not let terminal controls masquerade as CLI instructions.
const terminalText = (value: string) =>
  Array.from(value, (character) => {
    const code = character.charCodeAt(0);
    return code < 32 || (code >= 127 && code <= 159) || code === 8232 || code === 8233
      ? ' '
      : character;
  }).join('');
function renderInspection(value: unknown) {
  const parsed = inspectionResponse.safeParse(value);
  if (!parsed.success) {
    console.log(
      'Retained-continuation inspection unavailable (older daemon or unsupported response). No execution permission is implied.',
    );
    return;
  }
  const inspection = parsed.data.inspection;
  console.log(
    `Retained continuation: ${inspection.status === 'blocked' ? 'blocked' : 'requires exact selection'} (read-only)`,
  );
  for (const need of inspection.infrastructure.needs)
    console.log(
      `Need [${terminalText(need.owner ?? 'unknown owner')} / ${terminalText(need.phase ?? 'unknown phase')}]: ${terminalText(need.needs ?? 'not recorded')}${need.truncated ? ' [truncated; inspect original report]' : ''}`,
    );
  if (inspection.infrastructure.truncated)
    console.log('More needs omitted; inspect the retained reports.');
  if (inspection.infrastructure.state === 'not_checked')
    console.log(
      'Infrastructure needs are not available in selection evidence; inspect original reports.',
    );
  for (const check of inspection.checks.filter((item) => item.state === 'blocked'))
    console.log(
      `Blocked [${terminalText(check.id)} / ${terminalText(check.code ?? 'unknown')}]: ${terminalText(check.reason ?? 'Inspection refused')}`,
    );
  for (const operation of (parsed.data.operations ?? []).slice(0, 3)) {
    const stage = operation.blocked
      ? `blocked (${operation.blocked.code})`
      : operation.checked
        ? 'checked'
        : operation.checking
          ? 'checking'
          : operation.activated
            ? 'selected'
            : operation.prepared
              ? 'prepared'
              : 'claimed';
    console.log(
      `Retained operation ${terminalText(operation.id.slice(0, 256))}: ${terminalText(stage)}. Observe/reuse its request ID; do not create another to bypass custody.`,
    );
  }
  const prerequisites = inspection.prerequisites;
  console.log(
    `Generation: ${inspection.generation}; pending decision: ${prerequisites.pendingDecision ? 'yes' : 'none recorded'}`,
  );
  console.log(
    `Host path: ${prerequisites.hostPathRecorded ? 'recorded' : 'missing'}; source preservation: ${prerequisites.sourcePreservationRecorded ? 'recorded' : 'not recorded'}; worker settlement: ${prerequisites.workerSettlementRecorded ? 'recorded' : 'not recorded'}`,
  );
  console.log(
    inspection.selection
      ? `Selection: generation ${inspection.selection.expectedGeneration}, result/report hash ${terminalText(inspection.selection.expectedResultHash)}`
      : 'Selection evidence unavailable; no result/report hash can be selected yet.',
  );
  console.log(
    'Not checked: exact host source, original uncollected files/reports, resource state/identity, environment qualification and retry admission.',
  );
  console.log('Next steps (conditional, not execution permission):');
  for (const step of inspection.nextSteps) console.log(`- ${terminalText(step)}`);
}
export function registerRetainedContinuationCommand(
  program: Command,
  getClient: () => AutopodClient,
) {
  program
    .command('retained-continuation <id>')
    .description(
      'Preserve original resources; select independent source for repair or fresh checks without a coding worker',
    )
    .option('--apply', 'Prepare exact retained source; queue checks unless --prepare-only')
    .option('--prepare-only', 'Prepare an independent repair checkout; do not queue checks')
    .option(
      '--check',
      'Select the exact final committed candidate of an existing prepared operation',
    )
    .option('--request-id <id>', 'Stable recovery ID; reuse to observe an uncertain response')
    .option('--generation <number>', 'Exact original lifecycle generation')
    .option('--result-hash <sha256>', 'Exact result or pre-validation report hash from inspection')
    .option('--head <sha>', 'Exact original retained host HEAD')
    .option(
      '--remote-head <sha>',
      'Exact current published source branch HEAD to select independently',
    )
    .option('--candidate-head <sha>', 'Exact committed repair candidate to check')
    .option('--reason <text>', 'Human source-selection reason (10–4000 characters)')
    .option(
      '--preview-execution <profile>',
      'Preview replacement software/resources without changing task authority',
    )
    .option(
      '--execution-profile <profile>',
      'Explicit execution selection at preparation or, if not selected yet, --check',
    )
    .option('--execution-digest <sha256>', 'Exact replacement execution preview digest')
    .option(
      '--test-budget-seconds <seconds>',
      'One finite outer-test allowance at --check only (1–3600); not retry permission',
    )
    .option('--test-budget-reason <text>', 'Separate human reason for the one-shot test allowance')
    .option('--json', 'Output JSON')
    .action(
      async (
        id: string,
        opts: {
          apply?: boolean;
          prepareOnly?: boolean;
          check?: boolean;
          requestId?: string;
          generation?: string;
          resultHash?: string;
          head?: string;
          remoteHead?: string;
          candidateHead?: string;
          reason?: string;
          json?: boolean;
          previewExecution?: string;
          executionProfile?: string;
          executionDigest?: string;
          testBudgetSeconds?: string;
          testBudgetReason?: string;
        },
      ) => {
        const mutation =
          opts.prepareOnly ||
          opts.requestId ||
          opts.generation ||
          opts.resultHash ||
          opts.head ||
          opts.remoteHead ||
          opts.candidateHead ||
          opts.executionProfile ||
          opts.executionDigest ||
          opts.testBudgetSeconds ||
          opts.testBudgetReason ||
          opts.reason;
        if (opts.previewExecution && (mutation || opts.apply || opts.check))
          throw new Error('Execution preview is read-only; omit mutation flags.');
        if (
          Boolean(opts.executionProfile) !== Boolean(opts.executionDigest) ||
          (opts.executionDigest && !/^[a-f0-9]{64}$/.test(opts.executionDigest))
        )
          throw new Error(
            'Execution selection requires --execution-profile and the exact --execution-digest.',
          );
        if (!opts.apply && !opts.check && mutation)
          throw new Error('Mutation fields require --apply or --check.');
        if (opts.apply && opts.check) throw new Error('Choose --apply or --check, not both.');
        if (opts.check && (opts.head || opts.remoteHead || opts.prepareOnly))
          throw new Error('--check selects an existing candidate, not another source.');
        if (opts.apply || opts.check) {
          if (
            !opts.requestId ||
            !opts.generation ||
            !opts.resultHash ||
            !opts.reason ||
            (opts.apply ? !opts.head || opts.candidateHead : !opts.candidateHead)
          )
            throw new Error(
              'Selection requires --request-id, --generation, --result-hash, --reason and the exact --head or --candidate-head.',
            );
          if (
            !/^[a-zA-Z0-9-]{1,64}$/.test(opts.requestId) ||
            !/^[1-9][0-9]*$/.test(opts.generation) ||
            !Number.isSafeInteger(Number(opts.generation)) ||
            !/^[a-f0-9]{64}$/.test(opts.resultHash) ||
            !sha.test((opts.check ? opts.candidateHead : opts.head) ?? '') ||
            (opts.remoteHead !== undefined && !sha.test(opts.remoteHead)) ||
            opts.reason.trim().length < 10 ||
            opts.reason.length > 4000
          )
            throw new Error(
              'Invalid recovery ID, generation, exact SHA/hash or meaningful reason.',
            );
        }
        if (opts.testBudgetSeconds !== undefined || opts.testBudgetReason !== undefined) {
          if (
            !opts.check ||
            !opts.testBudgetSeconds ||
            !opts.testBudgetReason ||
            !/^[1-9][0-9]*$/.test(opts.testBudgetSeconds) ||
            Number(opts.testBudgetSeconds) > 3600 ||
            opts.testBudgetReason.trim().length < 10 ||
            opts.testBudgetReason.length > 4000
          )
            throw new Error(
              'A --check test allowance requires finite --test-budget-seconds (1–3600) and separate --test-budget-reason; retry authorization remains separate.',
            );
        }
        const client = getClient();
        const podId = await resolvePodId(client, id);
        const result = opts.previewExecution
          ? await client.previewRetainedExecution(podId, opts.previewExecution)
          : opts.check
            ? await client.checkRetainedCandidate(podId, opts.requestId as string, {
                expectedGeneration: Number(opts.generation),
                expectedResultHash: opts.resultHash as string,
                candidateHead: opts.candidateHead as string,
                ...(opts.testBudgetSeconds
                  ? {
                      testBudget: {
                        seconds: Number(opts.testBudgetSeconds),
                        reason: opts.testBudgetReason!.trim(),
                      },
                    }
                  : {}),
                ...(opts.executionProfile
                  ? {
                      executionProfileId: opts.executionProfile,
                      expectedExecutionDigest: opts.executionDigest,
                    }
                  : {}),
                reason: opts.reason as string,
              })
            : opts.apply
              ? await client.continueRetained(podId, {
                  id: opts.requestId as string,
                  expectedGeneration: Number(opts.generation),
                  expectedResultHash: opts.resultHash as string,
                  checkpointHead: opts.head as string,
                  ...(opts.remoteHead ? { remoteHead: opts.remoteHead } : {}),
                  prepareOnly: opts.prepareOnly ?? false,
                  ...(opts.executionProfile
                    ? {
                        executionProfileId: opts.executionProfile,
                        expectedExecutionDigest: opts.executionDigest,
                      }
                    : {}),
                  reason: opts.reason as string,
                })
              : await client.getCheckpointRecoveries(podId);
        const inspectionUnavailable =
          !opts.apply &&
          !opts.check &&
          !opts.previewExecution &&
          !inspectionResponse.safeParse(result).success;
        const output = inspectionUnavailable
          ? {
              ...(result && typeof result === 'object' && !Array.isArray(result)
                ? result
                : { response: result }),
              inspectionUnavailable:
                'Read-only inspection unavailable; no execution permission is implied.',
            }
          : result;
        withJsonOutput(opts, output, (value) => {
          if (!opts.apply && !opts.check && !opts.previewExecution) {
            renderInspection(value);
            return;
          }
          console.log(JSON.stringify(value, null, 2));
          console.log(
            opts.previewExecution
              ? 'Configuration preview only; actual environment qualification and task continuation are separate.'
              : 'Accepted is not passing checks. Originals remain retained; retry permission, qualified infrastructure and fresh approval are separate.',
          );
        });
      },
    );
}
