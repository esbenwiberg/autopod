import type { AgentActivityEvent, Session, SessionStatus, SystemEvent } from '@autopod/shared';
import chalk from 'chalk';
import type { Command } from 'commander';
import type { AutopodClient } from '../api/client.js';
import { formatDurationFromDates, formatStatus } from '../output/colors.js';
import { withJsonOutput } from '../output/json.js';
import { withSpinner } from '../output/spinner.js';
import { type ColumnDef, renderTable } from '../output/table.js';
import { formatToolUse } from '../utils/formatToolUse.js';
import { resolveSessionId } from '../utils/id-resolver.js';

const sessionColumns: ColumnDef<Session>[] = [
  { header: 'ID', formatter: (s) => s.id.slice(0, 8), width: 10 },
  { header: 'Profile', key: 'profileName', width: 16 },
  { header: 'Status', formatter: (s) => formatStatus(s.status), width: 18 },
  { header: 'Task', formatter: (s) => truncate(s.task, 40), width: 42 },
  {
    header: 'Duration',
    formatter: (s) => formatDurationFromDates(s.startedAt, s.completedAt),
    width: 10,
  },
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
    .option('--base-branch <branch>', 'Branch from a specific base (e.g. workspace output)')
    .option('--ac-from <path>', 'Load acceptance criteria from a file in the repo')
    .option('--skip-validation', 'Skip validation phase')
    .action(
      async (
        profile: string,
        task: string,
        opts: {
          model?: string;
          runtime?: string;
          branch?: string;
          baseBranch?: string;
          acFrom?: string;
          skipValidation?: boolean;
        },
      ) => {
        const client = getClient();
        const session = await withSpinner('Starting session...', () =>
          client.createSession({
            profileName: profile,
            task,
            model: opts.model,
            runtime: opts.runtime as 'claude' | 'codex' | undefined,
            branch: opts.branch,
            baseBranch: opts.baseBranch,
            acFrom: opts.acFrom,
            skipValidation: opts.skipValidation,
          }),
        );

        console.log(chalk.green(`Session ${chalk.bold(session.id)} created.`));
        console.log(`${chalk.bold('Profile:')}  ${session.profileName}`);
        console.log(`${chalk.bold('Status:')}   ${formatStatus(session.status)}`);
        console.log(`${chalk.bold('Branch:')}   ${session.branch}`);
        console.log(chalk.dim(`Track progress: ap status ${session.id.slice(0, 8)}`));
      },
    );

  // ap stats
  program
    .command('stats')
    .description('Show session counts grouped by status')
    .option('-p, --profile <profile>', 'Filter by profile')
    .option('--json', 'Output as JSON')
    .action(async (opts: { profile?: string; json?: boolean }) => {
      const client = getClient();
      const stats = await withSpinner('Fetching stats...', () =>
        client.getSessionStats({ profile: opts.profile }),
      );

      withJsonOutput(opts, stats, (data) => {
        console.log(chalk.bold(`Total: ${data.total}`));
        const entries = Object.entries(data.byStatus).filter(([, count]) => count > 0);
        if (entries.length === 0) {
          console.log(chalk.dim('No sessions.'));
          return;
        }
        for (const [status, count] of entries) {
          console.log(`  ${formatStatus(status as SessionStatus)}  ${count}`);
        }
      });
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
        console.log(
          `${chalk.bold('Duration:')}     ${formatDurationFromDates(s.startedAt, s.completedAt)}`,
        );
        console.log(
          `${chalk.bold('Validations:')}  ${s.validationAttempts}/${s.maxValidationAttempts}`,
        );
        console.log(`${chalk.bold('Escalations:')}  ${s.escalationCount}`);
        console.log(
          `${chalk.bold('Changes:')}      ${s.filesChanged} files (+${s.linesAdded} -${s.linesRemoved})`,
        );
        if (s.mergeBlockReason) {
          console.log(`${chalk.bold('Merge:')}        ${chalk.yellow(`⏳ ${s.mergeBlockReason}`)}`);
        }
        if (s.previewUrl) {
          console.log(`${chalk.bold('Preview:')}      ${s.previewUrl}`);
        }
        if (s.plan) {
          console.log(chalk.bold('\nPlan:'));
          console.log(`  ${s.plan.summary}`);
          s.plan.steps.forEach((step, i) => {
            const isCurrent = s.progress && i + 1 === s.progress.currentPhase;
            const prefix = isCurrent ? chalk.cyan('→') : chalk.dim('·');
            console.log(`  ${prefix} ${i + 1}. ${step}`);
          });
        }
        if (s.progress) {
          console.log(
            `${chalk.bold('Progress:')}     ${s.progress.currentPhase}/${s.progress.totalPhases} — ${s.progress.phase}`,
          );
          console.log(`${chalk.bold('Phase:')}        ${chalk.dim(s.progress.description)}`);
        }
        if (s.pendingEscalation) {
          if (s.pendingEscalation.type === 'validation_override') {
            const p = s.pendingEscalation.payload as {
              findings: Array<{
                id: string;
                source: string;
                description: string;
                reasoning?: string;
              }>;
              attempt: number;
              maxAttempts: number;
            };
            console.log(
              chalk.yellow.bold(
                `\nRecurring validation findings need review (attempt ${p.attempt}/${p.maxAttempts}):`,
              ),
            );
            console.log(chalk.dim('  (Auto-hoisted to deeper review tier — still flagged)\n'));
            for (const [i, f] of p.findings.entries()) {
              const sourceLabel =
                f.source === 'ac_validation' ? 'AC' : f.source === 'task_review' ? 'Review' : 'Req';
              console.log(`  ${chalk.bold(`[${i + 1}]`)} ${sourceLabel}: "${f.description}"`);
              if (f.reasoning) {
                console.log(`      ${chalk.dim(`→ ${f.reasoning}`)}`);
              }
            }
            console.log('');
            console.log(chalk.dim(`  ap tell ${s.id} dismiss       — dismiss all`));
            console.log(chalk.dim(`  ap tell ${s.id} dismiss 1     — dismiss finding #1`));
            console.log(chalk.dim(`  ap tell ${s.id} "fix: ..."    — provide guidance`));
          } else {
            console.log(chalk.yellow.bold('\nPending escalation:'));
            console.log(`  Type: ${s.pendingEscalation.type}`);
            const p = s.pendingEscalation.payload;
            console.log(
              `  Message: ${'question' in p ? p.question : 'description' in p ? p.description : ''}`,
            );
          }
        }
        if (s.lastValidationResult) {
          const vr = s.lastValidationResult;
          const color = vr.overall === 'pass' ? chalk.green : chalk.red;
          console.log(
            `\n${chalk.bold('Last validation:')} ${color(vr.overall.toUpperCase())} (attempt ${vr.attempt})`,
          );
        }
      });
    });

  // ap logs
  program
    .command('logs <id>')
    .description('Show session logs')
    .option('--build', 'Show build logs instead of agent logs')
    .option('-f, --follow', 'Follow log output in real-time via WebSocket')
    .action(async (id: string, opts: { build?: boolean; follow?: boolean }) => {
      const client = getClient();
      const resolvedId = await resolveSessionId(client, id);

      if (opts.follow) {
        const WebSocket = (await import('ws')).default;
        const token = await client.fetchToken();
        const wsUrl = client.getWebSocketUrl(`/events?token=${encodeURIComponent(token)}`);
        const ws = new WebSocket(wsUrl);

        ws.on('open', () => {
          ws.send(JSON.stringify({ type: 'subscribe', sessionId: resolvedId }));
          console.log(chalk.dim(`Following session ${resolvedId.slice(0, 8)}… (Ctrl+C to stop)\n`));
        });

        ws.on('message', (data: Buffer) => {
          try {
            const event = JSON.parse(data.toString()) as { type: string };
            // Skip subscribe/unsubscribe confirmations
            if (['subscribed', 'unsubscribed', 'subscribed_all', 'error'].includes(event.type))
              return;
            formatLogEvent(event as SystemEvent);
          } catch {
            // Ignore malformed messages
          }
        });

        ws.on('close', () => process.exit(0));
        ws.on('error', (err: Error) => {
          console.error(chalk.red(`WebSocket error: ${err.message}`));
          process.exit(1);
        });

        process.on('SIGINT', () => {
          ws.close();
          process.exit(0);
        });

        // Keep the process alive — the event loop stays open via the WebSocket
        return;
      }

      const logs = await withSpinner('Fetching logs...', () =>
        client.getSessionLogs(resolvedId, opts.build),
      );
      process.stdout.write(logs);
    });

  // ap pause
  program
    .command('pause <id>')
    .description('Pause a running session (container stays alive, agent suspended)')
    .action(async (id: string) => {
      const client = getClient();
      const resolvedId = await resolveSessionId(client, id);
      await withSpinner('Pausing session...', () => client.pauseSession(resolvedId));
      console.log(chalk.yellow(`Session ${resolvedId} paused.`));
      console.log(chalk.dim('Resume with: ap tell <id> "<message>"'));
    });

  // ap nudge
  program
    .command('nudge <id> <message>')
    .description('Send a soft message to a running agent (picked up via check_messages)')
    .action(async (id: string, message: string) => {
      const client = getClient();
      const resolvedId = await resolveSessionId(client, id);
      await withSpinner('Sending nudge...', () => client.nudgeSession(resolvedId, message));
      console.log(chalk.green('Nudge queued. Agent will see it on next check_messages call.'));
    });

  // ap tell
  program
    .command('tell <id> <message>')
    .description('Send a message to a session (for escalations or guidance)')
    .action(async (id: string, message: string) => {
      const client = getClient();
      const resolvedId = await resolveSessionId(client, id);
      await withSpinner('Sending message...', () => client.sendMessage(resolvedId, message));
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
          console.log(
            chalk.green(
              `Approved ${result.approved.length} session(s): ${result.approved.join(', ')}`,
            ),
          );
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
      await withSpinner('Rejecting session...', () => client.rejectSession(resolvedId, feedback));
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
          console.log(
            chalk.red(`Killed ${result.killed.length} session(s): ${result.killed.join(', ')}`),
          );
        }
        return;
      }

      if (!id) {
        console.error(chalk.red('Provide a session ID or use --all-failed'));
        process.exit(1);
      }

      const resolvedId = await resolveSessionId(client, id);
      await withSpinner('Killing session...', () => client.killSession(resolvedId));
      console.log(chalk.red(`Session ${resolvedId} killed.`));
    });
}

function formatTimestamp(ts: string): string {
  try {
    const d = new Date(ts);
    return chalk.dim(d.toLocaleTimeString());
  } catch {
    return chalk.dim(ts);
  }
}

function formatLogEvent(event: SystemEvent & { type: string }): void {
  const ts =
    'timestamp' in event ? formatTimestamp((event as { timestamp: string }).timestamp) : '';

  switch (event.type) {
    case 'session.agent_activity': {
      const activity = event as AgentActivityEvent;
      const inner = activity.event;
      switch (inner.type) {
        case 'status':
          console.log(`${ts} ${chalk.dim(inner.message)}`);
          break;
        case 'tool_use': {
          if (inner.tool === 'tool_result') break; // skip noisy tool_result acks
          console.log(
            `${ts} ${chalk.cyan('[tool]')} ${formatToolUse(inner.tool, inner.input, 80)}`,
          );
          break;
        }
        case 'file_change': {
          const actionColor =
            inner.action === 'delete'
              ? chalk.red
              : inner.action === 'create'
                ? chalk.green
                : chalk.yellow;
          console.log(`${ts} ${actionColor(`[${inner.action}]`)} ${inner.path}`);
          break;
        }
        case 'complete':
          console.log(`${ts} ${chalk.green.bold('Agent completed:')} ${inner.result}`);
          break;
        case 'error':
          console.log(`${ts} ${chalk.red(inner.fatal ? '[FATAL] ' : '[error] ')}${inner.message}`);
          break;
        case 'escalation': {
          const p = inner.payload.payload;
          const desc = 'question' in p ? p.question : p.description;
          console.log(
            `${ts} ${chalk.yellow.bold(`[escalation: ${inner.escalationType}]`)} ${desc}`,
          );
          break;
        }
        case 'plan':
          console.log(`${ts} ${chalk.magenta.bold('[plan]')} ${inner.summary}`);
          inner.steps.forEach((step: string, i: number) => {
            console.log(`${ts}   ${chalk.dim(`${i + 1}.`)} ${step}`);
          });
          break;
        case 'progress':
          console.log(
            `${ts} ${chalk.blue.bold(`[progress ${inner.currentPhase}/${inner.totalPhases}]`)} ${inner.phase} — ${inner.description}`,
          );
          break;
        default:
          console.log(`${ts} ${chalk.dim(JSON.stringify(inner))}`);
      }
      break;
    }
    case 'session.status_changed': {
      const sc = event as import('@autopod/shared').SessionStatusChangedEvent;
      console.log(`${ts} ${chalk.blue(`Status: ${sc.previousStatus} → ${sc.newStatus}`)}`);
      break;
    }
    case 'session.validation_started': {
      const vs = event as import('@autopod/shared').ValidationStartedEvent;
      console.log(`${ts} ${chalk.blue(`Validation started (attempt ${vs.attempt})`)}`);
      break;
    }
    case 'session.validation_completed': {
      const vc = event as import('@autopod/shared').ValidationCompletedEvent;
      const color = vc.result.overall === 'pass' ? chalk.green : chalk.red;
      console.log(
        `${ts} ${color(`Validation ${vc.result.overall.toUpperCase()}`)} (attempt ${vc.result.attempt})`,
      );
      break;
    }
    case 'session.escalation_created': {
      const ec = event as import('@autopod/shared').EscalationCreatedEvent;
      const desc =
        'question' in ec.escalation.payload
          ? ec.escalation.payload.question
          : ec.escalation.payload.description;
      console.log(`${ts} ${chalk.yellow.bold(`[escalation: ${ec.escalation.type}]`)} ${desc}`);
      break;
    }
    case 'session.escalation_resolved': {
      console.log(`${ts} ${chalk.green('Escalation resolved')}`);
      break;
    }
    case 'session.completed': {
      const comp = event as import('@autopod/shared').SessionCompletedEvent;
      const color = comp.finalStatus === 'complete' ? chalk.green.bold : chalk.red.bold;
      console.log(`${ts} ${color(`Session ${comp.finalStatus}`)}`);
      break;
    }
    case 'session.created': {
      const cr = event as import('@autopod/shared').SessionCreatedEvent;
      console.log(`${ts} ${chalk.blue('Session created:')} ${cr.session.id.slice(0, 8)}`);
      break;
    }
    default:
      console.log(`${ts} ${chalk.dim(JSON.stringify(event))}`);
  }
}
