import {
  type RepairContinuationInspectionV1,
  type RepairContinuationOperationV1,
  type RepairContinuationPreviewV1,
  repairContinuationPreviewQueryV1Schema,
  repairContinuationRequestV1Schema,
} from '@autopod/shared';
import type { Command } from 'commander';
import { z } from 'zod';
import type { AutopodClient } from '../api/client.js';
import { withJsonOutput } from '../output/json.js';
import { resolvePodId } from '../utils/id-resolver.js';

interface Options {
  apply?: boolean;
  observe?: string;
  previewExecution?: string;
  requestId?: string;
  generation?: string;
  resultHash?: string;
  reportSetHash?: string;
  head?: string;
  executionProfile?: string;
  executionDigest?: string;
  bindingDigest?: string;
  reason?: string;
  json?: boolean;
}

// Reports and reasons are untrusted terminal text, not instructions.
const safeText = (value: string) =>
  Array.from(value, (character) => {
    const code = character.charCodeAt(0);
    return code < 32 || (code >= 127 && code <= 159) || code === 8232 || code === 8233
      ? ' '
      : character;
  }).join('');

function selection(opts: Options) {
  const fields = [
    opts.requestId,
    opts.generation,
    opts.resultHash,
    opts.reportSetHash,
    opts.executionProfile,
    opts.executionDigest,
    opts.bindingDigest,
    opts.reason,
  ];
  const modes = [
    opts.apply === true,
    opts.observe !== undefined,
    opts.previewExecution !== undefined,
  ];
  if (modes.filter(Boolean).length > 1)
    throw new Error('Choose --apply, --observe or --preview-execution, not multiple modes.');
  if (opts.observe !== undefined) {
    if (fields.some((field) => field !== undefined) || opts.head !== undefined)
      throw new Error('--observe is read-only; omit all selection fields.');
    return {
      mode: 'observe' as const,
      id: repairContinuationRequestV1Schema.shape.id.parse(opts.observe),
    };
  }
  if (opts.previewExecution !== undefined) {
    if (fields.some((field) => field !== undefined))
      throw new Error('Configuration preview is read-only; omit authorization fields.');
    return {
      mode: 'preview' as const,
      query: repairContinuationPreviewQueryV1Schema.parse({
        sourceHead: opts.head,
        executionProfileId: opts.previewExecution,
      }),
    };
  }
  if (!opts.apply) {
    if (fields.some((field) => field !== undefined) || opts.head !== undefined)
      throw new Error('Selection fields require --apply (or --preview-execution with --head).');
    return { mode: 'inspect' as const };
  }
  if (opts.generation === undefined || !/^(?:0|[1-9][0-9]*)$/.test(opts.generation))
    throw new Error('--generation must be the exact nonnegative safe integer from preview.');
  return {
    mode: 'apply' as const,
    request: repairContinuationRequestV1Schema.parse({
      version: 1,
      intent: 'qualify_then_code_once',
      id: opts.requestId,
      expectedGeneration: Number(opts.generation),
      expectedResultHash: opts.resultHash,
      expectedReportSetHash: opts.reportSetHash,
      sourceHead: opts.head,
      executionProfileId: opts.executionProfile,
      expectedExecutionDigest: opts.executionDigest,
      expectedBindingDigest: opts.bindingDigest,
      reason: opts.reason,
    }),
  };
}

function renderOperation(value: RepairContinuationOperationV1) {
  console.log(`Repair request ${safeText(value.request.id)}: ${value.state}`);
  console.log(
    `Qualification: ${value.qualification?.outcome ?? 'not run'}; coding admission: ${value.codingAdmission}; checks: ${value.checks}`,
  );
  console.log(
    'Original resources retained. Human approval remains separate; no publication authorized.',
  );
  for (const refusal of value.refusals)
    console.log(`Refused [${refusal.code}]: ${safeText(refusal.message)}`);
}

function renderView(value: RepairContinuationInspectionV1 | RepairContinuationPreviewV1) {
  if ('configurationOnly' in value) {
    console.log(
      `Configuration preview only: conditional attempt ${value.conditionalAttemptEligible ? 'supported' : 'refused'}. Actual qualification: ${value.actualQualification}.`,
    );
    if (value.configurationDiff) {
      for (const side of ['before', 'after'] as const) {
        const item = value.configurationDiff[side];
        console.log(
          `${side}: ${item.target} / ${safeText(item.template)} / ${item.platform}; memory ${item.memoryGb} GiB; CPUs ${item.cpus ?? 'unknown'}; image key ${item.imageKey}`,
        );
      }
    }
    if (value.selection) console.log(`Exact selection: ${JSON.stringify(value.selection)}`);
    console.log(
      'Authorization permits provision + bounded qualification + one coding continuation IF qualified. Preview is not proof and cannot skip probes.',
    );
  } else {
    console.log(
      `Repair continuation: ${value.available ? 'inspect exact conditional selection' : 'unavailable/refused'}; generation ${value.generation}`,
    );
    console.log(
      `Retained HOST HEAD: ${value.sourceHead ?? 'unavailable'}; result hash: ${value.expectedResultHash ?? 'unavailable'}; report-set hash: ${value.expectedReportSetHash ?? 'unavailable'}`,
    );
    if (value.operation) renderOperation(value.operation);
  }
  for (const refusal of value.refusals)
    console.log(`Refused [${refusal.code}]: ${safeText(refusal.message)}`);
  console.log(
    'Host Git source is not a claim to contain final sandbox bytes. Unsynced/ignored files and original reports remain retained.',
  );
  console.log(
    'Repository, task, AI, runtime, workflow, network, credentials, actions and cumulative budgets stay frozen. Retry grants and budget changes are separate decisions.',
  );
  console.log(
    'Machine wakeup, retained checks-only selection and Resume delivery are separate operations, not fallbacks.',
  );
}

async function context(client: AutopodClient, id: string) {
  const observe = async (read: () => Promise<unknown>) => {
    try {
      return { state: 'observed' as const, value: await read() };
    } catch (error) {
      return {
        state: 'unavailable' as const,
        reason: error instanceof Error ? error.message : 'Observation failed',
      };
    }
  };
  // Read-only display composition; unavailable context never becomes implicit permission.
  return {
    sourceAndReports: await observe(() => client.getCheckpointRecoveries(id)),
    cumulativeBudget: await observe(() => client.getTaskExecution(id)),
    workerRetries: await observe(() => client.getRetryState(id, 'worker')),
    startupRetries: await observe(() => client.getRetryState(id, 'sandbox_startup')),
    validationRetries: await observe(() => client.getRetryState(id, 'validation')),
  };
}

const reportContext = z.object({
  inspection: z
    .object({
      infrastructure: z.object({
        state: z.string(),
        truncated: z.boolean(),
        needs: z.array(
          z.object({
            owner: z.string().optional(),
            phase: z.string().optional(),
            needs: z.string().optional(),
            truncated: z.boolean(),
          }),
        ),
      }),
      prerequisites: z.object({
        sourcePreservationRecorded: z.boolean(),
        workerSettlementRecorded: z.boolean(),
        pendingDecision: z.boolean(),
      }),
    })
    .nullable(),
});
const budgetContext = z.object({
  tokenBudget: z.number().nullable(),
  recordedTotalTokens: z.number().optional(),
  telemetry: z.string(),
  budgetCheck: z.object({ status: z.string(), reason: z.string() }).optional(),
});
const retryContext = z.object({
  stage: z.string(),
  admissionCount: z.number(),
  executedCount: z.number(),
  telemetry: z.string(),
  authorizationRequired: z.boolean().optional(),
  latest: z
    .object({
      id: z.string(),
      outcome: z.string().nullable(),
      providerRetryNotBefore: z.string().nullable().optional(),
    })
    .nullable(),
  authorizations: z.array(
    z.object({ id: z.string(), failureId: z.string(), usedByAttemptId: z.string().nullable() }),
  ),
});
function renderContext(observations: Awaited<ReturnType<typeof context>>) {
  for (const [name, observation] of Object.entries(observations)) {
    if (observation.state === 'unavailable') {
      console.log(`${name}: unavailable — ${safeText(observation.reason)}`);
    } else if (name === 'sourceAndReports') {
      const parsed = reportContext.safeParse(observation.value);
      const original = parsed.success ? parsed.data.inspection : null;
      if (!original) {
        console.log('Original report/preservation context unavailable.');
        continue;
      }
      console.log(
        `Original markers (not final sandbox byte proof): preservation ${original.prerequisites.sourcePreservationRecorded ? 'recorded' : 'not recorded'}, settlement ${original.prerequisites.workerSettlementRecorded ? 'recorded' : 'not recorded'}, pending decision ${original.prerequisites.pendingDecision ? 'yes' : 'none recorded'}.`,
      );
      console.log(`Reported infrastructure: ${safeText(original.infrastructure.state)}`);
      for (const need of original.infrastructure.needs.slice(0, 20))
        console.log(
          `Need [${safeText((need.owner ?? 'unknown owner').slice(0, 128))} / ${safeText((need.phase ?? 'unknown phase').slice(0, 128))}]: ${safeText((need.needs ?? 'not recorded').slice(0, 1024))}${need.truncated ? ' [truncated]' : ''}`,
        );
      if (original.infrastructure.truncated || original.infrastructure.needs.length > 20)
        console.log('More needs omitted; inspect original reports. No requirement is waived.');
    } else if (name === 'cumulativeBudget') {
      const parsed = budgetContext.safeParse(observation.value);
      if (!parsed.success) {
        console.log('Cumulative budget unavailable, not zero or permission.');
        continue;
      }
      const budget = parsed.data;
      console.log(
        `Cumulative tokens: ${budget.recordedTotalTokens ?? 'unavailable'}; limit: ${budget.tokenBudget ?? 'not configured'}; telemetry: ${safeText(budget.telemetry)}; budget admission: ${safeText(budget.budgetCheck?.status ?? 'unavailable')}.`,
      );
      if (budget.budgetCheck) console.log(safeText(budget.budgetCheck.reason));
    } else {
      const parsed = retryContext.safeParse(observation.value);
      if (!parsed.success) {
        console.log(`${name}: accounting unavailable, not retry permission.`);
        continue;
      }
      const retry = parsed.data;
      console.log(
        `${name}: ${retry.admissionCount} admissions / ${retry.executedCount} executions; latest ${safeText(retry.latest?.id ?? 'unavailable')} / ${safeText(retry.latest?.outcome ?? 'unknown')}; cooldown ${safeText(retry.latest?.providerRetryNotBefore ?? 'none recorded')}; telemetry ${safeText(retry.telemetry)}.`,
      );
      for (const grant of retry.authorizations.slice(0, 10))
        console.log(
          `Grant ${safeText(grant.id)} for failure ${safeText(grant.failureId)}: ${grant.usedByAttemptId ? 'consumed' : 'recorded unused decision'}.`,
        );
    }
  }
}

export function registerRepairContinuationCommand(
  program: Command,
  getClient: () => AutopodClient,
) {
  program
    .command('repair-continuation <id>')
    .description(
      'Inspect or conditionally authorize replacement qualification and ONE fresh coding segment; never delivery',
    )
    .option(
      '--preview-execution <profile>',
      'Read-only configuration/conditional eligibility preview; requires --head',
    )
    .option(
      '--observe <request-id>',
      'Read-only observation of the exact saved request; never resubmits',
    )
    .option(
      '--apply',
      'Authorize provision + qualification + one coding continuation IF it qualifies',
    )
    .option(
      '--request-id <id>',
      'Caller-saved stable request ID; never replace after an uncertain outcome',
    )
    .option('--generation <number>', 'Exact original generation from preview')
    .option('--result-hash <hash>', 'Exact original result hash')
    .option('--report-set-hash <hash>', 'Exact complete original report-set hash')
    .option('--head <sha>', 'Exact retained HOST HEAD (not remote or future edited source)')
    .option('--execution-profile <profile>', 'Explicit reviewed replacement profile')
    .option('--execution-digest <hash>', 'Exact replacement configuration preview digest')
    .option('--binding-digest <hash>', 'Exact opaque preview binding digest')
    .option('--reason <text>', 'Meaningful authorization reason (10–4000 characters)')
    .option('--json', 'Preserve structured observations/receipts as JSON')
    .action(async (id: string, opts: Options) => {
      const selected = selection(opts); // All mode/field errors precede client/auth/ID resolution.
      const client = getClient();
      const podId = await resolvePodId(client, id);
      if (selected.mode === 'apply') {
        let operation: RepairContinuationOperationV1;
        try {
          operation = await client.authorizeRepairContinuation(podId, selected.request);
        } catch (error) {
          throw new Error(
            `${error instanceof Error ? safeText(error.message) : 'Authorization response unavailable'}\nAuthorization NOT confirmed; it may be refused or recorded. Do not invent a new request ID.\nObserve: ap repair-continuation ${JSON.stringify(podId)} --observe ${JSON.stringify(selected.request.id)}${opts.json ? ' --json' : ''}\nExact request (retain unchanged): ${JSON.stringify(selected.request)}`,
          );
        }
        withJsonOutput(opts, operation, renderOperation);
      } else if (selected.mode === 'observe') {
        const operation = await client.observeRepairContinuation(podId, selected.id);
        withJsonOutput(opts, operation, renderOperation);
      } else {
        const view =
          selected.mode === 'preview'
            ? await client.previewRepairContinuation(podId, selected.query)
            : await client.inspectRepairContinuation(podId);
        const observations = await context(client, podId);
        withJsonOutput(opts, { ...view, context: observations }, (result) => {
          renderView(result);
          console.log(
            'Read-only original reports / cumulative budget / retry accounting (unknown is not zero; recorded usage is not a spending reservation):',
          );
          renderContext(observations);
        });
      }
    });
}
