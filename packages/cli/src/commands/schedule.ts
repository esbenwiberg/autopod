import { createInterface } from 'node:readline';
import type { ScheduledJob, ScheduledJobTemplate } from '@autopod/shared';
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
  { header: 'PROMPT', formatter: (t) => t.prompt.replace(/\s+/g, ' ').slice(0, 48), width: 50 },
];

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
    .option('--disabled', 'Create the scheduled job disabled')
    .action(
      async (profile: string, args: string[], opts: { template?: string; disabled?: boolean }) => {
        const client = getClient();
        let job: ScheduledJob;

        if (opts.template) {
          const [cron] = args;
          if (!cron) {
            throw new Error('Usage: ap schedule create <profile> <cron> --template <id-or-name>');
          }
          const templateId = await resolveTemplateId(client, opts.template);
          job = await client.createScheduledJob({
            profileName: profile,
            templateId,
            cronExpression: cron,
            enabled: !opts.disabled,
          });
        } else {
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
    .action(async (name: string, prompt: string) => {
      const client = getClient();
      const created = await client.createScheduledJobTemplate({ name, prompt });
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
      console.log(`${chalk.bold('Prompt:')} ${item.prompt}`);
    });

  template
    .command('edit <id>')
    .description('Edit a scheduled job template')
    .option('--name <name>', 'New template name')
    .option('--prompt <prompt>', 'New template prompt')
    .action(async (id: string, opts: { name?: string; prompt?: string }) => {
      if (opts.name === undefined && opts.prompt === undefined) {
        throw new Error('Pass at least one of --name or --prompt');
      }
      const client = getClient();
      const updated = await client.updateScheduledJobTemplate(id, {
        name: opts.name,
        prompt: opts.prompt,
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
      console.log(`${chalk.bold('Task:')}         ${job.task}`);
    });

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
