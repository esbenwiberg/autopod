import type {
  PodsitterActivation,
  PodsitterConfiguration,
  PodsitterDecisionRecord,
  PodsitterRuntime,
} from '@autopod/shared';
import chalk from 'chalk';
import type { Command } from 'commander';
import type {
  AutopodClient,
  PodsitterStatusResponse,
  UpdatePodsitterConfigurationRequest,
} from '../api/client.js';
import { withJsonOutput } from '../output/json.js';
import { withSpinner } from '../output/spinner.js';

const DEFAULT_BUDGETS = { maxDecisionsPerWindow: 20, maxActionsPerWindow: 10 };

interface RedactedPodsitterDecision {
  id: string;
  podId: string;
  action: string | null;
  outcome: PodsitterDecisionRecord['outcome'];
  confidence: string | null;
  evidenceRefCount: number;
  createdAt: string;
  completedAt: string | null;
  executedAt: string | null;
}

interface RedactedPodsitterStatus {
  enabled: boolean;
  active: boolean;
  activation: PodsitterActivation | null;
  authorizedUntil: string | null;
  decisionTarget: {
    providerAccountId: string;
    runtime: string;
    model: string;
  } | null;
  providerCircuit: {
    status: string;
    consecutiveFailures: number;
    nextProbeAt: string | null;
    recoveredAt: string | null;
  } | null;
  pendingCount: number;
  lastAction: RedactedPodsitterDecision | null;
}

function positiveInteger(value: string, label: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  return parsed;
}

export function parsePodsitterDuration(value: string): number {
  const match = /^(\d+)(m|h|d|w)$/.exec(value.trim());
  if (!match?.[1] || !match[2]) {
    throw new Error(`Invalid duration "${value}"; use a whole number followed by m, h, d, or w`);
  }
  const amount = Number(match[1]);
  if (!Number.isSafeInteger(amount) || amount < 1) {
    throw new Error('Duration must be greater than zero');
  }
  const multipliers = { m: 1, h: 60, d: 1_440, w: 10_080 };
  return amount * multipliers[match[2] as keyof typeof multipliers];
}

export function parsePodsitterExpiry(value: string, now = new Date()): string {
  const trimmed = value.trim();
  if (/^\d+(m|h|d|w)$/.test(trimmed)) {
    return new Date(now.getTime() + parsePodsitterDuration(trimmed) * 60_000).toISOString();
  }
  const explicitZoneIso =
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/;
  if (!explicitZoneIso.test(trimmed)) {
    throw new Error(
      `Invalid expiry "${value}"; use ISO-8601 with Z or an explicit offset, or a duration such as 12h`,
    );
  }
  const timestamp = new Date(trimmed);
  if (Number.isNaN(timestamp.getTime())) {
    throw new Error(
      `Invalid expiry "${value}"; use ISO-8601 with Z or an explicit offset, or a duration such as 12h`,
    );
  }
  return timestamp.toISOString();
}

function assertTimeZone(value: string): void {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format();
  } catch {
    throw new Error(`Invalid IANA timezone "${value}"`);
  }
}

function configurationRequest(
  configuration: PodsitterConfiguration | null,
): UpdatePodsitterConfigurationRequest {
  return configuration
    ? {
        enabled: configuration.enabled,
        activation: configuration.activation,
        authorizedUntil: configuration.authorizedUntil,
        profileScope: configuration.profileScope,
        decisionTarget: configuration.decisionTarget,
        budgets: configuration.budgets,
      }
    : {
        enabled: false,
        activation: { mode: 'always' },
        authorizedUntil: null,
        profileScope: null,
        decisionTarget: null,
        budgets: DEFAULT_BUDGETS,
      };
}

function redactDecision(record: PodsitterDecisionRecord): RedactedPodsitterDecision {
  return {
    id: record.id,
    podId: record.podId,
    action: record.decision?.action ?? null,
    outcome: record.outcome,
    confidence: record.decision?.confidence ?? null,
    evidenceRefCount: record.decision?.evidenceRefs.length ?? 0,
    createdAt: record.createdAt,
    completedAt: record.completedAt,
    executedAt: record.executedAt,
  };
}

function redactStatus(
  status: PodsitterStatusResponse,
  lastAction: PodsitterDecisionRecord | null,
): RedactedPodsitterStatus {
  const target = status.configuration?.decisionTarget;
  const provider = status.provider;
  return {
    enabled: status.configuration?.enabled ?? false,
    active: status.activation?.active ?? false,
    activation: status.configuration?.activation ?? null,
    authorizedUntil: status.configuration?.authorizedUntil ?? null,
    decisionTarget: target
      ? {
          providerAccountId: target.providerAccountId,
          runtime: target.runtime,
          model: target.model,
        }
      : null,
    providerCircuit: provider
      ? {
          status: provider.status,
          consecutiveFailures: provider.consecutiveFailures,
          nextProbeAt: provider.retryAt ?? provider.resetAt,
          recoveredAt: provider.recoveredAt,
        }
      : null,
    pendingCount: status.queueCount,
    lastAction: lastAction ? redactDecision(lastAction) : null,
  };
}

function renderStatus(status: RedactedPodsitterStatus) {
  console.log(chalk.bold.cyan('Daemon-native Podsitter'));
  console.log(chalk.dim("This is separate from Pilot's local /podsitter extension."));
  console.log(`${chalk.bold('Enabled:')}      ${status.enabled ? 'yes' : 'no'}`);
  console.log(`${chalk.bold('Active:')}       ${status.active ? 'yes' : 'no'}`);
  console.log(`${chalk.bold('Expiry:')}       ${status.authorizedUntil ?? '-'}`);
  if (status.activation?.mode === 'always') {
    console.log(`${chalk.bold('Activation:')}   always`);
  } else if (status.activation?.mode === 'recurring') {
    console.log(
      `${chalk.bold('Activation:')}   ${status.activation.cronExpression} for ${status.activation.durationMinutes}m (${status.activation.timeZone})`,
    );
  }
  const target = status.decisionTarget;
  console.log(`${chalk.bold('Account:')}      ${target?.providerAccountId ?? '-'}`);
  console.log(
    `${chalk.bold('Runtime/model:')} ${target ? `${target.runtime} / ${target.model}` : '-'}`,
  );
  console.log(`${chalk.bold('Provider:')}     ${status.providerCircuit?.status ?? 'unconfigured'}`);
  console.log(`${chalk.bold('Next probe:')}   ${status.providerCircuit?.nextProbeAt ?? '-'}`);
  console.log(`${chalk.bold('Pending:')}      ${status.pendingCount}`);
  console.log(
    `${chalk.bold('Last action:')}  ${status.lastAction?.action ?? '-'}${status.lastAction ? ` (${status.lastAction.outcome})` : ''}`,
  );
}

function renderDecisions(result: {
  items: RedactedPodsitterDecision[];
  total: number;
}): void {
  if (result.items.length === 0) {
    console.log(chalk.dim('No daemon-native Podsitter decisions found.'));
    return;
  }
  for (const record of result.items) {
    console.log(`${record.createdAt}  ${record.podId}  ${record.action ?? '-'}  ${record.outcome}`);
    console.log(
      `  Confidence: ${record.confidence ?? '-'} · Evidence references: ${record.evidenceRefCount}`,
    );
  }
  console.log(chalk.dim(`Showing ${result.items.length} of ${result.total} decision(s).`));
}

export function registerPodsitterCommands(program: Command, getClient: () => AutopodClient): void {
  const podsitter = program
    .command('podsitter')
    .description("Control the daemon-native Podsitter (not Pilot's local /podsitter extension)");

  podsitter
    .command('configure')
    .description('Configure the dedicated decision provider account')
    .requiredOption('--account <id>', 'Authenticated provider account ID')
    .requiredOption('--runtime <runtime>', 'Decision runtime: claude, codex, copilot, or pi')
    .requiredOption('--model <model>', 'Decision model')
    .action(async (opts: { account: string; runtime: string; model: string }) => {
      if (!['claude', 'codex', 'copilot', 'pi'].includes(opts.runtime)) {
        throw new Error('runtime must be one of: claude, codex, copilot, pi');
      }
      const client = getClient();
      const status = await client.getPodsitterStatus();
      const updated = await client.updatePodsitterConfiguration({
        ...configurationRequest(status.configuration),
        decisionTarget: {
          providerAccountId: opts.account,
          runtime: opts.runtime as PodsitterRuntime,
          model: opts.model,
        },
      });
      console.log(
        chalk.green(
          `Daemon-native Podsitter configured for ${updated.decisionTarget?.providerAccountId}.`,
        ),
      );
      console.log(chalk.dim('Authenticate accounts with: ap provider-account auth <id>'));
    });

  podsitter
    .command('on')
    .description('Authorize daemon-native Podsitter continuously or on a recurring schedule')
    .option('--always', 'Authorize continuously')
    .option('--cron <expression>', 'Five-field recurring start schedule')
    .option('--duration <duration>', 'Recurring window duration, e.g. 12h')
    .option('--timezone <iana>', 'Recurring IANA timezone, e.g. Europe/Copenhagen')
    .option(
      '--until <iso-or-duration>',
      'Absolute expiry or duration from now, e.g. 2026-08-01T06:00:00Z or 12h',
    )
    .action(
      async (opts: {
        always?: boolean;
        cron?: string;
        duration?: string;
        timezone?: string;
        until?: string;
      }) => {
        if (Boolean(opts.always) === Boolean(opts.cron)) {
          throw new Error('Exactly one of --always or --cron is required');
        }
        let activation: PodsitterActivation;
        if (opts.cron) {
          if (!opts.duration || !opts.timezone) {
            throw new Error('Recurring activation requires --duration and --timezone');
          }
          assertTimeZone(opts.timezone);
          activation = {
            mode: 'recurring',
            cronExpression: opts.cron,
            durationMinutes: parsePodsitterDuration(opts.duration),
            timeZone: opts.timezone,
          };
        } else {
          if (opts.duration || opts.timezone) {
            throw new Error('--duration and --timezone may only be used with --cron');
          }
          activation = { mode: 'always' };
        }
        const client = getClient();
        const status = await client.getPodsitterStatus();
        const updated = await client.updatePodsitterConfiguration({
          ...configurationRequest(status.configuration),
          enabled: true,
          activation,
          authorizedUntil: opts.until ? parsePodsitterExpiry(opts.until) : null,
        });
        console.log(
          chalk.green(
            `Daemon-native Podsitter enabled (${updated.activation.mode}${updated.authorizedUntil ? `, until ${updated.authorizedUntil}` : ''}).`,
          ),
        );
      },
    );

  podsitter
    .command('off')
    .description('Immediately disable daemon-native Podsitter (daemon kill switch)')
    .action(async () => {
      await getClient().disablePodsitter();
      console.log(chalk.yellow('Daemon-native Podsitter disabled immediately (kill switch).'));
    });

  podsitter
    .command('status')
    .description('Show daemon-native Podsitter authorization, provider circuit, and queue')
    .option('--json', 'Output redacted daemon data as JSON')
    .action(async (opts: { json?: boolean }) => {
      const client = getClient();
      const [status, decisions] = await Promise.all([
        withSpinner('Fetching daemon-native Podsitter status...', () =>
          client.getPodsitterStatus(),
        ),
        client.listPodsitterDecisions({ limit: 1, offset: 0 }),
      ]);
      const output = redactStatus(status, decisions.items[0] ?? null);
      withJsonOutput(opts, output, renderStatus);
    });

  podsitter
    .command('check')
    .description('Reconcile daemon attention now (read-only while authorization is inactive)')
    .action(async () => {
      const client = getClient();
      const before = await client.getPodsitterStatus();
      const result = await client.checkPodsitter();
      const disabled = !before.configuration?.enabled;
      const outsideWindow = !before.activation?.active;
      console.log(
        disabled
          ? `Read-only check complete: ${result.queued} attention state(s) found; Podsitter is disabled.`
          : outsideWindow
            ? `Check complete outside the authorization window: ${result.queued} queued, ${result.processed} processed; provider state may be updated.`
            : `Check complete: ${result.queued} queued, ${result.processed} processed.`,
      );
    });

  podsitter
    .command('probe')
    .description('Run a bounded, single-flight probe of the dedicated decision provider')
    .action(async () => {
      const result = await getClient().probePodsitterProvider();
      console.log(
        result.recovered
          ? chalk.green('Dedicated Podsitter provider is available.')
          : chalk.yellow('Provider probe completed without recovery; see `ap podsitter status`.'),
      );
    });

  podsitter
    .command('decisions')
    .description('Show redacted daemon-native Podsitter decision history')
    .option('--pod <id>', 'Filter by exact pod ID')
    .option('--limit <n>', 'Maximum records (default: daemon-defined)', (v) =>
      positiveInteger(v, 'limit'),
    )
    .option('--offset <n>', 'Pagination offset', (v) => positiveInteger(v, 'offset'))
    .option('--json', 'Output redacted daemon data as JSON')
    .action(async (opts: { pod?: string; limit?: number; offset?: number; json?: boolean }) => {
      const result = await withSpinner('Fetching Podsitter decisions...', () =>
        getClient().listPodsitterDecisions({
          podId: opts.pod,
          limit: opts.limit,
          offset: opts.offset,
        }),
      );
      const output = {
        items: result.items.map(redactDecision),
        total: result.total,
      };
      withJsonOutput(opts, output, renderDecisions);
    });
}
