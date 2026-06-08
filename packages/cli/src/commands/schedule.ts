import { createInterface } from 'node:readline';
import type {
  ScheduledJob,
  ScheduledJobTemplate,
  ScheduledJobTemplateField,
} from '@autopod/shared';
import chalk from 'chalk';
import type { Command } from 'commander';
import type { AutopodClient } from '../api/client.js';
import { withJsonOutput } from '../output/json.js';
import { type ColumnDef, renderTable } from '../output/table.js';

function confirm(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  return new Promise((resolve) => {
    rl.question(`${question} [y/N] `, (answer: string) => {
      rl.close();
      resolve(answer.toLowerCase() === 'y');
    });
  });
}

function formatNextRun(nextRunAt: string): string {
  const diff = new Date(nextRunAt).getTime() - Date.now();
  if (diff < 0) return chalk.red('overdue');
  const minutes = Math.floor(diff / 60_000);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  if (days > 0) return `in ${days}d ${hours % 24}h`;
  if (hours > 0) return `in ${hours}h ${minutes % 60}m`;
  return `in ${minutes}m`;
}

function formatRelativeAgo(isoDate: string | null): string {
  if (!isoDate) return 'never';
  const diff = Date.now() - new Date(isoDate).getTime();
  const minutes = Math.floor(diff / 60_000);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  if (days > 0) return `${days}d ago`;
  if (hours > 0) return `${hours}h ago`;
  return `${minutes}m ago`;
}

function formatJobStatus(job: ScheduledJob): string {
  if (job.catchupPending) return chalk.yellow('catchup pending');
  if (!job.enabled) return chalk.dim('disabled');
  return chalk.green('active');
}

const jobColumns: ColumnDef<ScheduledJob>[] = [
  { header: 'ID', formatter: (j) => j.id.slice(0, 10), width: 12 },
  { header: 'NAME', key: 'name', width: 22 },
  { header: 'TEMPLATE', key: 'templateName', width: 22 },
  { header: 'PROFILE', key: 'profileName', width: 14 },
  { header: 'CRON', key: 'cronExpression', width: 14 },
  { header: 'ENABLED', formatter: (j) => (j.enabled ? 'yes' : 'no'), width: 9 },
  { header: 'NEXT RUN', formatter: (j) => formatNextRun(j.nextRunAt), width: 12 },
  { header: 'STATUS', formatter: formatJobStatus, width: 16 },
];

const templateColumns: ColumnDef<ScheduledJobTemplate>[] = [
  { header: 'ID', formatter: (t) => t.id.slice(0, 10), width: 12 },
  { header: 'NAME', key: 'name', width: 28 },
  { header: 'FIELDS', formatter: (t) => String(t.fields?.length ?? 0), width: 8 },
  { header: 'PROMPT', formatter: (t) => t.prompt.replace(/\s+/g, ' ').slice(0, 48), width: 50 },
];

function collect(value: string, previous: string[] = []): string[] {
  return [...previous, value];
}

function parseFields(value: string | undefined): ScheduledJobTemplateField[] | undefined {
  if (value === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error('--fields must be a JSON array');
  }
  if (!Array.isArray(parsed)) {
    throw new Error('--fields must be a JSON array');
  }
  return parsed.map((item) => {
    if (typeof item !== 'object' || item === null) {
      throw new Error('--fields entries must be objects');
    }
    const field = item as Record<string, unknown>;
    if (
      typeof field.key !== 'string' ||
      typeof field.label !== 'string' ||
      typeof field.required !== 'boolean'
    ) {
      throw new Error('--fields entries need key, label, and required');
    }
    return {
      key: field.key,
      label: field.label,
      required: field.required,
      ...(typeof field.defaultValue === 'string' ? { defaultValue: field.defaultValue } : {}),
    };
  });
}

function parseFieldValues(values: string[] | undefined): Record<string, string> | undefined {
  if (!values || values.length === 0) return undefined;
  const result: Record<string, string> = {};
  for (const item of values) {
    const separator = item.indexOf('=');
    if (separator <= 0) {
      throw new Error('--set values must use key=value');
    }
    result[item.slice(0, separator)] = item.slice(separator + 1);
  }
  return result;
}

async function resolveTemplateId(client: AutopodClient, value: string): Promise<string> {
  const templates = await client.listScheduledJobTemplates();
  const exact = templates.find((template) => template.id === value || template.name === value);
  if (exact) return exact.id;

  const matches = templates.filter((template) =>
    template.name.toLowerCase().includes(value.toLowerCase()),
  );
  if (matches.length === 1 && matches[0]) return matches[0].id;
  if (matches.length > 1) {
    throw new Error(
      `Template "${value}" is ambiguous: ${matches.map((template) => template.name).join(', ')}`,
    );
  }

  throw new Error(`Scheduled job template not found: ${value}`);
}

export function registerScheduleCommands(program: Command, getClient: () => AutopodClient): void {
  const schedule = program
    .command('schedule')
    .description('Manage scheduled jobs (ap schedule <subcommand>)');

  // ap schedule create <profile> <cron> --template <id-or-name>
  // Legacy form remains supported: ap schedule create <profile> <name> <cron> <task>
  schedule
    .command('create <profile> [args...]')
    .description('Create a scheduled job')
    .option('-t, --template <idOrName>', 'Template ID or name to use')
    .option('--set <keyValue>', 'Template override value (repeatable key=value)', collect, [])
    .option('--disabled', 'Create the scheduled job disabled')
    .action(
      async (
        profile: string,
        args: string[],
        opts: { template?: string; set?: string[]; disabled?: boolean },
      ) => {
        const client = getClient();
        let job: ScheduledJob;
        const fieldValues = parseFieldValues(opts.set);

        if (opts.template) {
          const [cron] = args;
          if (!cron) {
            throw new Error('Usage: ap schedule create <profile> <cron> --template <id-or-name>');
          }
          const templateId = await resolveTemplateId(client, opts.template);
          job = await client.createScheduledJob({
            profileName: profile,
            templateId,
            fieldValues,
            cronExpression: cron,
            enabled: !opts.disabled,
          });
        } else {
          if (fieldValues) {
            throw new Error('Template override values require --template');
          }
          const [name, cron, task] = args;
          if (!name || !cron || !task) {
            throw new Error('Usage: ap schedule create <profile> <name> <cron> <task>');
          }
          job = await client.createScheduledJob({
            profileName: profile,
            name,
            cronExpression: cron,
            task,
            enabled: !opts.disabled,
          });
        }

        console.log(chalk.green(`Schedule ${chalk.bold(job.id.slice(0, 10))} created.`));
        console.log(`${chalk.bold('Template:')} ${job.templateName}`);
        console.log(
          `${chalk.bold('Next run:')} ${formatNextRun(job.nextRunAt)} (${job.nextRunAt})`,
        );
      },
    );

  const template = schedule.command('template').description('Manage scheduled job templates');

  template
    .command('create <name> <prompt>')
    .description('Create a scheduled job template')
    .option('--fields <json>', 'JSON array of template field definitions')
    .action(async (name: string, prompt: string, opts: { fields?: string }) => {
      const client = getClient();
      const created = await client.createScheduledJobTemplate({
        name,
        prompt,
        fields: parseFields(opts.fields),
      });
      console.log(chalk.green(`Template ${chalk.bold(created.id.slice(0, 10))} created.`));
    });

  template
    .command('list')
    .description('List scheduled job templates')
    .option('--json', 'Output as JSON')
    .action(async (opts: { json?: boolean }) => {
      const client = getClient();
      const templates = await client.listScheduledJobTemplates();
      withJsonOutput(opts, templates, (data) => {
        if (data.length === 0) {
          console.log(
            'No scheduled job templates. Use: ap schedule template create <name> <prompt>',
          );
          return;
        }
        console.log(renderTable(data, templateColumns));
      });
    });

  template
    .command('show <id>')
    .description('Show a scheduled job template')
    .action(async (id: string) => {
      const client = getClient();
      const item = await client.getScheduledJobTemplate(id);
      console.log(`${chalk.bold('ID:')}     ${item.id}`);
      console.log(`${chalk.bold('Name:')}   ${item.name}`);
      if ((item.fields?.length ?? 0) > 0) {
        console.log(`${chalk.bold('Fields:')}`);
        for (const field of item.fields) {
          const required = field.required ? 'required' : 'optional';
          const fallback = field.defaultValue ? ` default=${field.defaultValue}` : '';
          console.log(`  ${field.key} (${field.label}, ${required}${fallback})`);
        }
      }
      console.log(`${chalk.bold('Prompt:')} ${item.prompt}`);
    });

  template
    .command('edit <id>')
    .description('Edit a scheduled job template')
    .option('--name <name>', 'New template name')
    .option('--prompt <prompt>', 'New template prompt')
    .option('--fields <json>', 'JSON array of template field definitions')
    .action(async (id: string, opts: { name?: string; prompt?: string; fields?: string }) => {
      if (opts.name === undefined && opts.prompt === undefined && opts.fields === undefined) {
        throw new Error('Pass at least one of --name, --prompt, or --fields');
      }
      const client = getClient();
      const updated = await client.updateScheduledJobTemplate(id, {
        name: opts.name,
        prompt: opts.prompt,
        fields: parseFields(opts.fields),
      });
      console.log(chalk.green(`Template ${chalk.bold(updated.id.slice(0, 10))} updated.`));
    });

  template
    .command('delete <id>')
    .description('Delete a scheduled job template')
    .action(async (id: string) => {
      const client = getClient();
      await client.deleteScheduledJobTemplate(id);
      console.log('Template deleted.');
    });

  // ap schedule list
  schedule
    .command('list')
    .description('List all scheduled jobs')
    .option('--json', 'Output as JSON')
    .action(async (opts: { json?: boolean }) => {
      const client = getClient();
      const jobs = await client.listScheduledJobs();
      withJsonOutput(opts, jobs, (data) => {
        if (data.length === 0) {
          console.log('No scheduled jobs. Use: ap schedule create <profile> <name> <cron> <task>');
          return;
        }
        console.log(renderTable(data, jobColumns));
      });
    });

  // ap schedule show <id>
  schedule
    .command('show <id>')
    .description('Show details of a scheduled job')
    .action(async (id: string) => {
      const client = getClient();
      const job = await client.getScheduledJob(id);
      console.log(`${chalk.bold('ID:')}           ${job.id}`);
      console.log(`${chalk.bold('Name:')}         ${job.name}`);
      console.log(`${chalk.bold('Template:')}     ${job.templateName} (${job.templateId})`);
      console.log(`${chalk.bold('Profile:')}      ${job.profileName}`);
      console.log(`${chalk.bold('Cron:')}         ${job.cronExpression}`);
      console.log(`${chalk.bold('Enabled:')}      ${job.enabled ? 'yes' : 'no'}`);
      console.log(
        `${chalk.bold('Next run:')}     ${formatNextRun(job.nextRunAt)} (${job.nextRunAt})`,
      );
      console.log(`${chalk.bold('Last run:')}     ${formatRelativeAgo(job.lastRunAt)}`);
      console.log(`${chalk.bold('Last pod:')} ${job.lastPodId ?? '-'}`);
      console.log(`${chalk.bold('Status:')}       ${formatJobStatus(job)}`);
      if (Object.keys(job.fieldValues ?? {}).length > 0) {
        console.log(`${chalk.bold('Overrides:')}`);
        for (const [key, value] of Object.entries(job.fieldValues)) {
          console.log(`  ${key}=${value}`);
        }
      }
      console.log(`${chalk.bold('Task:')}         ${job.task}`);
    });

  schedule
    .command('edit <id>')
    .description('Edit a scheduled job')
    .option('-t, --template <idOrName>', 'Template ID or name to use')
    .option('--profile <profile>', 'Profile name')
    .option('--cron <cron>', 'Cron expression')
    .option('--set <keyValue>', 'Template override value (repeatable key=value)', collect, [])
    .option('--enabled', 'Enable the scheduled job')
    .option('--disabled', 'Disable the scheduled job')
    .action(
      async (
        id: string,
        opts: {
          template?: string;
          profile?: string;
          cron?: string;
          set?: string[];
          enabled?: boolean;
          disabled?: boolean;
        },
      ) => {
        if (opts.enabled && opts.disabled) {
          throw new Error('Pass only one of --enabled or --disabled');
        }

        const client = getClient();
        const templateId = opts.template
          ? await resolveTemplateId(client, opts.template)
          : undefined;
        const fieldValues = parseFieldValues(opts.set);
        if (
          templateId === undefined &&
          opts.profile === undefined &&
          opts.cron === undefined &&
          fieldValues === undefined &&
          opts.enabled === undefined &&
          opts.disabled === undefined
        ) {
          throw new Error('Pass at least one schedule edit option');
        }
        const job = await client.updateScheduledJob(id, {
          templateId,
          profileName: opts.profile,
          cronExpression: opts.cron,
          fieldValues,
          enabled: opts.enabled ? true : opts.disabled ? false : undefined,
        });

        console.log(chalk.green(`Schedule ${chalk.bold(job.id.slice(0, 10))} updated.`));
      },
    );

  // ap schedule enable <id>
  schedule
    .command('enable <id>')
    .description('Enable a disabled scheduled job')
    .action(async (id: string) => {
      const client = getClient();
      const job = await client.updateScheduledJob(id, { enabled: true });
      console.log(chalk.green(`Schedule ${chalk.bold(job.id.slice(0, 10))} enabled.`));
    });

  // ap schedule disable <id>
  schedule
    .command('disable <id>')
    .description('Disable a scheduled job without deleting it')
    .action(async (id: string) => {
      const client = getClient();
      const job = await client.updateScheduledJob(id, { enabled: false });
      console.log(chalk.yellow(`Schedule ${chalk.bold(job.id.slice(0, 10))} disabled.`));
    });

  // ap schedule delete <id>
  schedule
    .command('delete <id>')
    .description('Delete a scheduled job')
    .action(async (id: string) => {
      const client = getClient();
      await client.deleteScheduledJob(id);
      console.log('Schedule deleted.');
    });

  // ap schedule run <id>
  schedule
    .command('run <id>')
    .description('Manually trigger a run now (ignores schedule)')
    .action(async (id: string) => {
      const client = getClient();
      const pod = await client.triggerScheduledJob(id);
      console.log(chalk.green(`Pod ${chalk.bold(pod.id)} started.`));
      console.log(chalk.dim(`Track progress: ap status ${pod.id.slice(0, 8)}`));
    });

  // ap schedule catchup
  schedule
    .command('catchup')
    .description('Review and action pending catch-up jobs')
    .action(async () => {
      const client = getClient();
      const jobs = await client.listScheduledJobs();
      const pending = jobs.filter((j) => j.catchupPending);

      if (pending.length === 0) {
        console.log('No jobs need catch-up.');
        return;
      }

      for (const job of pending) {
        const lastRunStr = formatRelativeAgo(job.lastRunAt);
        const run = await confirm(
          `Job "${chalk.bold(job.name)}" was last run ${lastRunStr}. Run now?`,
        );

        if (run) {
          const pod = await client.runScheduledJobCatchup(job.id);
          console.log(chalk.green(`Pod ${chalk.bold(pod.id)} started.`));
        } else {
          await client.skipScheduledJobCatchup(job.id);
          console.log('Skipped.');
        }
      }
    });
}
