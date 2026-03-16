import type { Command } from 'commander';
import chalk from 'chalk';
import type { Session } from '@autopod/shared';
import type { AutopodClient } from '../api/client.js';
import { withSpinner } from '../output/spinner.js';
import { withJsonOutput } from '../output/json.js';
import { renderTable, type ColumnDef } from '../output/table.js';
import { formatStatus, formatDurationFromDates } from '../output/colors.js';
import { resolveSessionId } from '../utils/id-resolver.js';

const sessionColumns: ColumnDef<Session>[] = [
  { header: 'ID', formatter: (s) => s.id.slice(0, 8), width: 10 },
  { header: 'Profile', key: 'profileName', width: 16 },
  { header: 'Status', formatter: (s) => formatStatus(s.status), width: 18 },
  { header: 'Task', formatter: (s) => truncate(s.task, 40), width: 42 },
  { header: 'Duration', formatter: (s) => formatDurationFromDates(s.startedAt, s.completedAt), width: 10 },
  { header: 'Files', formatter: (s) => String(s.filesChanged), width: 7 },
];

function truncate(str: string, max: number): string {
  if (str.length <= max) return str;
  return `${str.slice(0, max - 1)}…`;
}

export function registerSessionCommands(program: Command, getClient: () => AutopodClient): void {
  // ap run
  program
    .command('run <profile> <task>')
    .description('Start a new coding session')
    .option('-m, --model <model>', 'AI model to use')
    .option('-r, --runtime <runtime>', 'Runtime (claude or codex)')
    .option('-b, --branch <branch>', 'Target branch name')
    .option('--skip-validation', 'Skip validation phase')
    .action(async (profile: string, task: string, opts: { model?: string; runtime?: string; branch?: string; skipValidation?: boolean }) => {
      const client = getClient();
      const session = await withSpinner('Starting session...', () =>
        client.createSession({
          profileName: profile,
          task,
          model: opts.model,
          runtime: opts.runtime as 'claude' | 'codex' | undefined,
          branch: opts.branch,
          skipValidation: opts.skipValidation,
        }),
      );

      console.log(chalk.green(`Session ${chalk.bold(session.id)} created.`));
      console.log(`${chalk.bold('Profile:')}  ${session.profileName}`);
      console.log(`${chalk.bold('Status:')}   ${formatStatus(session.status)}`);
      console.log(`${chalk.bold('Branch:')}   ${session.branch}`);
      console.log(chalk.dim(`Track progress: ap status ${session.id.slice(0, 8)}`));
    });

  // ap ls
  program
    .command('ls')
    .description('List sessions')
    .option('-s, --status <status>', 'Filter by status')
    .option('-p, --profile <profile>', 'Filter by profile')
    .option('--json', 'Output as JSON')
    .action(async (opts: { status?: string; profile?: string; json?: boolean }) => {
      const client = getClient();
      const sessions = await withSpinner('Fetching sessions...', () =>
        client.listSessions({ status: opts.status, profile: opts.profile }),
      );

      withJsonOutput(opts, sessions, (data) => {
        if (data.length === 0) {
          console.log(chalk.dim('No sessions found.'));
          return;
        }
        console.log(renderTable(data, sessionColumns));
      });
    });

  // ap status
  program
    .command('status <id>')
    .description('Show detailed session status')
    .option('--json', 'Output as JSON')
    .action(async (id: string, opts: { json?: boolean }) => {
      const client = getClient();
      const resolvedId = await resolveSessionId(client, id);
      const session = await client.getSession(resolvedId);

      withJsonOutput(opts, session, (s) => {
        console.log(chalk.bold.cyan(`Session ${s.id}`));
        console.log(chalk.dim('─'.repeat(50)));
        console.log(`${chalk.bold('Profile:')}      ${s.profileName}`);
        console.log(`${chalk.bold('Status:')}       ${formatStatus(s.status)}`);
        console.log(`${chalk.bold('Task:')}         ${s.task}`);
        console.log(`${chalk.bold('Model:')}        ${s.model}`);
        console.log(`${chalk.bold('Runtime:')}      ${s.runtime}`);
        console.log(`${chalk.bold('Branch:')}       ${s.branch}`);
        console.log(`${chalk.bold('Duration:')}     ${formatDurationFromDates(s.startedAt, s.completedAt)}`);
        console.log(`${chalk.bold('Validations:')}  ${s.validationAttempts}/${s.maxValidationAttempts}`);
        console.log(`${chalk.bold('Escalations:')}  ${s.escalationCount}`);
        console.log(`${chalk.bold('Changes:')}      ${s.filesChanged} files (+${s.linesAdded} -${s.linesRemoved})`);
        if (s.previewUrl) {
          console.log(`${chalk.bold('Preview:')}      ${s.previewUrl}`);
        }
        if (s.pendingEscalation) {
          console.log(chalk.yellow.bold('\nPending escalation:'));
          console.log(`  Type: ${s.pendingEscalation.type}`);
          console.log(`  Message: ${s.pendingEscalation.payload.message}`);
        }
        if (s.lastValidationResult) {
          const vr = s.lastValidationResult;
          const color = vr.overall === 'pass' ? chalk.green : chalk.red;
          console.log(`\n${chalk.bold('Last validation:')} ${color(vr.overall.toUpperCase())} (attempt ${vr.attempt})`);
        }
      });
    });

  // ap logs
  program
    .command('logs <id>')
    .description('Show session logs')
    .option('--build', 'Show build logs instead of agent logs')
    .option('-f, --follow', 'Follow log output (TODO: requires WebSocket)')
    .action(async (id: string, opts: { build?: boolean; follow?: boolean }) => {
      const client = getClient();
      const resolvedId = await resolveSessionId(client, id);

      if (opts.follow) {
        // TODO: Implement WebSocket-based log streaming
        console.log(chalk.yellow('--follow is not yet implemented. Showing current logs.'));
      }

      const logs = await withSpinner('Fetching logs...', () =>
        client.getSessionLogs(resolvedId, opts.build),
      );
      process.stdout.write(logs);
    });

  // ap tell
  program
    .command('tell <id> <message>')
    .description('Send a message to a session (for escalations or guidance)')
    .action(async (id: string, message: string) => {
      const client = getClient();
      const resolvedId = await resolveSessionId(client, id);
      await withSpinner('Sending message...', () =>
        client.sendMessage(resolvedId, message),
      );
      console.log(chalk.green('Message sent.'));
    });

  // ap approve
  program
    .command('approve [id]')
    .description('Approve a validated session for merge')
    .option('--squash', 'Squash commits on merge')
    .option('--all-validated', 'Approve all validated sessions')
    .action(async (id: string | undefined, opts: { squash?: boolean; allValidated?: boolean }) => {
      const client = getClient();

      if (opts.allValidated) {
        const result = await withSpinner('Approving all validated sessions...', () =>
          client.approveAllValidated(),
        );
        if (result.approved.length === 0) {
          console.log(chalk.dim('No validated sessions to approve.'));
        } else {
          console.log(chalk.green(`Approved ${result.approved.length} session(s): ${result.approved.join(', ')}`));
        }
        return;
      }

      if (!id) {
        console.error(chalk.red('Provide a session ID or use --all-validated'));
        process.exit(1);
      }

      const resolvedId = await resolveSessionId(client, id);
      await withSpinner('Approving session...', () =>
        client.approveSession(resolvedId, { squash: opts.squash }),
      );
      console.log(chalk.green(`Session ${resolvedId} approved.`));
    });

  // ap reject
  program
    .command('reject <id> <feedback>')
    .description('Reject a session and send it back for rework')
    .action(async (id: string, feedback: string) => {
      const client = getClient();
      const resolvedId = await resolveSessionId(client, id);
      await withSpinner('Rejecting session...', () =>
        client.rejectSession(resolvedId, feedback),
      );
      console.log(chalk.yellow(`Session ${resolvedId} rejected with feedback.`));
    });

  // ap kill
  program
    .command('kill [id]')
    .description('Kill a running session')
    .option('--all-failed', 'Kill all failed sessions')
    .action(async (id: string | undefined, opts: { allFailed?: boolean }) => {
      const client = getClient();

      if (opts.allFailed) {
        const result = await withSpinner('Killing failed sessions...', () =>
          client.killAllFailed(),
        );
        if (result.killed.length === 0) {
          console.log(chalk.dim('No failed sessions to kill.'));
        } else {
          console.log(chalk.red(`Killed ${result.killed.length} session(s): ${result.killed.join(', ')}`));
        }
        return;
      }

      if (!id) {
        console.error(chalk.red('Provide a session ID or use --all-failed'));
        process.exit(1);
      }

      const resolvedId = await resolveSessionId(client, id);
      await withSpinner('Killing session...', () =>
        client.killSession(resolvedId),
      );
      console.log(chalk.red(`Session ${resolvedId} killed.`));
    });
}
