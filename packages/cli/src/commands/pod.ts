import type { AgentActivityEvent, Pod, PodStatus, SystemEvent } from '@autopod/shared';
import chalk from 'chalk';
import type { Command } from 'commander';
import type { AutopodClient } from '../api/client.js';
import { formatDurationFromDates, formatStatus } from '../output/colors.js';
import { withJsonOutput } from '../output/json.js';
import { withSpinner } from '../output/spinner.js';
import { type ColumnDef, renderTable } from '../output/table.js';
import { formatToolUse } from '../utils/formatToolUse.js';
import { resolvePodId } from '../utils/id-resolver.js';

const podColumns: ColumnDef<Pod>[] = [
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

// Commander collector for repeatable `--sidecar <name>` flags.
function collectRepeatable(value: string, previous: string[]): string[] {
  return previous.concat(value);
}

export function registerPodCommands(program: Command, getClient: () => AutopodClient): void {
  // ap run
  program
    .command('run <profile> <task>')
    .description('Start a new coding pod')
    .option('-m, --model <model>', 'AI model to use')
    .option('-r, --runtime <runtime>', 'Runtime (claude or codex)')
    .option('-b, --branch <branch>', 'Target branch name')
    .option('--branch-prefix <prefix>', 'Override branch prefix (e.g. hotfix/)')
    .option('--base-branch <branch>', 'Branch from a specific base (e.g. workspace output)')
    .option('--ac-from <path>', 'Load acceptance criteria from a file in the repo')
    .option('--skip-validation', 'Skip validation phase')
    .option(
      '-s, --sidecar <name>',
      'Companion sidecar to spawn (e.g. "dagger"). Repeatable. Requires the profile to have sidecars.<name> enabled; privileged sidecars also require trustedSource.',
      collectRepeatable,
      [] as string[],
    )
    .action(
      async (
        profile: string,
        task: string,
        opts: {
          model?: string;
          runtime?: string;
          branch?: string;
          branchPrefix?: string;
          baseBranch?: string;
          acFrom?: string;
          skipValidation?: boolean;
          sidecar: string[];
        },
      ) => {
        const client = getClient();
        const pod = await withSpinner('Starting pod...', () =>
          client.createSession({
            profileName: profile,
            task,
            model: opts.model,
            runtime: opts.runtime as 'claude' | 'codex' | undefined,
            branch: opts.branch,
            branchPrefix: opts.branchPrefix,
            baseBranch: opts.baseBranch,
            acFrom: opts.acFrom,
            skipValidation: opts.skipValidation,
            requireSidecars: opts.sidecar.length > 0 ? opts.sidecar : undefined,
          }),
        );

        console.log(chalk.green(`Pod ${chalk.bold(pod.id)} created.`));
        console.log(`${chalk.bold('Profile:')}  ${pod.profileName}`);
        console.log(`${chalk.bold('Status:')}   ${formatStatus(pod.status)}`);
        console.log(`${chalk.bold('Branch:')}   ${pod.branch}`);
        console.log(chalk.dim(`Track progress: ap status ${pod.id.slice(0, 8)}`));
      },
    );

  // ap start
  //
  // The unified pod primitive. Replaces the (still-present) ap run / ap
  // workspace / ap research trio. Flags let you pick any combination of the
  // two orthogonal axes: who drives (agent vs human) and where output goes.
  program
    .command('start <profile> [task]')
    .description('Start a pod (unified). Flags pick the pod config.')
    .option('--agent <mode>', 'Who drives the pod: auto (default, runs the agent) or interactive')
    .option('--output <target>', 'Where output goes: pr | branch | artifact | none')
    .option('--validate', 'Run full validation pipeline before completing')
    .option('--no-validate', 'Skip validation')
    .option('-m, --model <model>', 'AI model to use')
    .option('-r, --runtime <runtime>', 'Runtime (claude or codex)')
    .option('-b, --branch <branch>', 'Target branch name')
    .option('--branch-prefix <prefix>', 'Override branch prefix (e.g. hotfix/)')
    .option('--base-branch <branch>', 'Branch from a specific base')
    .option('--ac-from <path>', 'Load acceptance criteria from a file in the repo')
    .option(
      '-s, --sidecar <name>',
      'Companion sidecar to spawn (e.g. "dagger"). Repeatable. Requires the profile to have sidecars.<name> enabled; privileged sidecars also require trustedSource.',
      collectRepeatable,
      [] as string[],
    )
    .action(
      async (
        profile: string,
        task: string | undefined,
        opts: {
          agent?: string;
          output?: string;
          validate?: boolean;
          model?: string;
          runtime?: string;
          branch?: string;
          branchPrefix?: string;
          baseBranch?: string;
          acFrom?: string;
          sidecar: string[];
        },
      ) => {
        const client = getClient();
        const agent = opts.agent as 'auto' | 'interactive' | undefined;
        const output = opts.output as 'pr' | 'branch' | 'artifact' | 'none' | undefined;

        if (agent && agent !== 'auto' && agent !== 'interactive') {
          console.error(chalk.red(`--agent must be 'auto' or 'interactive'`));
          process.exit(1);
        }
        if (output && !['pr', 'branch', 'artifact', 'none'].includes(output)) {
          console.error(chalk.red('--output must be one of pr|branch|artifact|none'));
          process.exit(1);
        }

        const podOptions =
          agent || output || opts.validate !== undefined
            ? {
                ...(agent ? { agentMode: agent } : {}),
                ...(output ? { output } : {}),
                ...(opts.validate !== undefined ? { validate: opts.validate } : {}),
              }
            : undefined;

        const isInteractive = agent === 'interactive';
        if (!task && !isInteractive) {
          console.error(chalk.red('task is required unless --agent interactive'));
          process.exit(1);
        }

        const pod = await withSpinner('Starting pod…', () =>
          client.createSession({
            profileName: profile,
            task: task ?? '',
            model: opts.model,
            runtime: opts.runtime as 'claude' | 'codex' | undefined,
            branch: opts.branch,
            branchPrefix: opts.branchPrefix,
            baseBranch: opts.baseBranch,
            acFrom: opts.acFrom,
            options: podOptions,
            requireSidecars: opts.sidecar.length > 0 ? opts.sidecar : undefined,
          }),
        );

        console.log(chalk.green(`Pod ${chalk.bold(pod.id)} created.`));
        console.log(`${chalk.bold('Profile:')}  ${pod.profileName}`);
        console.log(`${chalk.bold('Status:')}   ${formatStatus(pod.status)}`);
        console.log(`${chalk.bold('Branch:')}   ${pod.branch}`);
        console.log(
          `${chalk.bold('Pod:')}      ${pod.options?.agentMode ?? 'auto'} → ${pod.options?.output ?? 'pr'}`,
        );
        if (pod.options?.agentMode === 'interactive') {
          console.log(chalk.dim(`Attach: ap attach ${pod.id.slice(0, 8)}`));
        } else {
          console.log(chalk.dim(`Track progress: ap status ${pod.id.slice(0, 8)}`));
        }
      },
    );

  // ap stats
  program
    .command('stats')
    .description('Show pod counts grouped by status')
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
          console.log(chalk.dim('No pods.'));
          return;
        }
        for (const [status, count] of entries) {
          console.log(`  ${formatStatus(status as PodStatus)}  ${count}`);
        }
      });
    });

  // ap ls
  program
    .command('ls')
    .description('List pods')
    .option('-s, --status <status>', 'Filter by status')
    .option('-p, --profile <profile>', 'Filter by profile')
    .option('--json', 'Output as JSON')
    .action(async (opts: { status?: string; profile?: string; json?: boolean }) => {
      const client = getClient();
      const pods = await withSpinner('Fetching pods...', () =>
        client.listSessions({ status: opts.status, profile: opts.profile }),
      );

      withJsonOutput(opts, pods, (data) => {
        if (data.length === 0) {
          console.log(chalk.dim('No pods found.'));
          return;
        }
        console.log(renderTable(data, podColumns));
      });
    });

  // ap status
  program
    .command('status <id>')
    .description('Show detailed pod status')
    .option('--json', 'Output as JSON')
    .action(async (id: string, opts: { json?: boolean }) => {
      const client = getClient();
      const resolvedId = await resolvePodId(client, id);
      const pod = await client.getSession(resolvedId);

      withJsonOutput(opts, pod, (s) => {
        console.log(chalk.bold.cyan(`Pod ${s.id}`));
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
    .description('Show pod logs')
    .option('--build', 'Show build logs instead of agent logs')
    .option('-f, --follow', 'Follow log output in real-time via WebSocket')
    .action(async (id: string, opts: { build?: boolean; follow?: boolean }) => {
      const client = getClient();
      const resolvedId = await resolvePodId(client, id);

      if (opts.follow) {
        const WebSocket = (await import('ws')).default;
        const token = await client.fetchToken();
        const wsUrl = client.getWebSocketUrl(`/events?token=${encodeURIComponent(token)}`);
        const ws = new WebSocket(wsUrl);

        ws.on('open', () => {
          ws.send(JSON.stringify({ type: 'subscribe', podId: resolvedId }));
          console.log(chalk.dim(`Following pod ${resolvedId.slice(0, 8)}… (Ctrl+C to stop)\n`));
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
    .description('Pause a running pod (container stays alive, agent suspended)')
    .action(async (id: string) => {
      const client = getClient();
      const resolvedId = await resolvePodId(client, id);
      await withSpinner('Pausing pod...', () => client.pauseSession(resolvedId));
      console.log(chalk.yellow(`Pod ${resolvedId} paused.`));
      console.log(chalk.dim('Resume with: ap tell <id> "<message>"'));
    });

  // ap nudge
  program
    .command('nudge <id> <message>')
    .description('Send a soft message to a running agent (picked up via check_messages)')
    .action(async (id: string, message: string) => {
      const client = getClient();
      const resolvedId = await resolvePodId(client, id);
      await withSpinner('Sending nudge...', () => client.nudgeSession(resolvedId, message));
      console.log(chalk.green('Nudge queued. Agent will see it on next check_messages call.'));
    });

  // ap tell
  program
    .command('tell <id> <message>')
    .description('Send a message to a pod (for escalations or guidance)')
    .action(async (id: string, message: string) => {
      const client = getClient();
      const resolvedId = await resolvePodId(client, id);
      await withSpinner('Sending message...', () => client.sendMessage(resolvedId, message));
      console.log(chalk.green('Message sent.'));
    });

  // ap approve
  program
    .command('approve [id]')
    .description('Approve a validated pod for merge')
    .option('--squash', 'Squash commits on merge')
    .option('--all-validated', 'Approve all validated pods')
    .action(async (id: string | undefined, opts: { squash?: boolean; allValidated?: boolean }) => {
      const client = getClient();

      if (opts.allValidated) {
        const result = await withSpinner('Approving all validated pods...', () =>
          client.approveAllValidated(),
        );
        if (result.approved.length === 0) {
          console.log(chalk.dim('No validated pods to approve.'));
        } else {
          console.log(
            chalk.green(`Approved ${result.approved.length} pod(s): ${result.approved.join(', ')}`),
          );
        }
        return;
      }

      if (!id) {
        console.error(chalk.red('Provide a pod ID or use --all-validated'));
        process.exit(1);
      }

      const resolvedId = await resolvePodId(client, id);
      await withSpinner('Approving pod...', () =>
        client.approveSession(resolvedId, { squash: opts.squash }),
      );
      console.log(chalk.green(`Pod ${resolvedId} approved.`));
    });

  // ap reject
  program
    .command('reject <id> <feedback>')
    .description('Reject a pod and send it back for rework')
    .action(async (id: string, feedback: string) => {
      const client = getClient();
      const resolvedId = await resolvePodId(client, id);
      await withSpinner('Rejecting pod...', () => client.rejectSession(resolvedId, feedback));
      console.log(chalk.yellow(`Pod ${resolvedId} rejected with feedback.`));
    });

  // ap kill
  program
    .command('kill [id]')
    .description('Kill a running pod')
    .option('--all-failed', 'Kill all failed pods')
    .action(async (id: string | undefined, opts: { allFailed?: boolean }) => {
      const client = getClient();

      if (opts.allFailed) {
        const result = await withSpinner('Killing failed pods...', () => client.killAllFailed());
        if (result.killed.length === 0) {
          console.log(chalk.dim('No failed pods to kill.'));
        } else {
          console.log(
            chalk.red(`Killed ${result.killed.length} pod(s): ${result.killed.join(', ')}`),
          );
        }
        return;
      }

      if (!id) {
        console.error(chalk.red('Provide a pod ID or use --all-failed'));
        process.exit(1);
      }

      const resolvedId = await resolvePodId(client, id);
      await withSpinner('Killing pod...', () => client.killSession(resolvedId));
      console.log(chalk.red(`Pod ${resolvedId} killed.`));
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
    case 'pod.agent_activity': {
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
          const desc =
            'question' in p
              ? p.question
              : 'description' in p
                ? (p as { description: string }).description
                : 'reason' in p
                  ? (p as { reason: string }).reason
                  : '(override)';
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
    case 'pod.status_changed': {
      const sc = event as import('@autopod/shared').PodStatusChangedEvent;
      console.log(`${ts} ${chalk.blue(`Status: ${sc.previousStatus} → ${sc.newStatus}`)}`);
      break;
    }
    case 'pod.validation_started': {
      const vs = event as import('@autopod/shared').ValidationStartedEvent;
      console.log(`${ts} ${chalk.blue(`Validation started (attempt ${vs.attempt})`)}`);
      break;
    }
    case 'pod.validation_completed': {
      const vc = event as import('@autopod/shared').ValidationCompletedEvent;
      const color = vc.result.overall === 'pass' ? chalk.green : chalk.red;
      console.log(
        `${ts} ${color(`Validation ${vc.result.overall.toUpperCase()}`)} (attempt ${vc.result.attempt})`,
      );
      break;
    }
    case 'pod.escalation_created': {
      const ec = event as import('@autopod/shared').EscalationCreatedEvent;
      const ep = ec.escalation.payload;
      const desc =
        'question' in ep
          ? ep.question
          : 'description' in ep
            ? (ep as { description: string }).description
            : 'reason' in ep
              ? (ep as { reason: string }).reason
              : '(override)';
      console.log(`${ts} ${chalk.yellow.bold(`[escalation: ${ec.escalation.type}]`)} ${desc}`);
      break;
    }
    case 'pod.escalation_resolved': {
      console.log(`${ts} ${chalk.green('Escalation resolved')}`);
      break;
    }
    case 'pod.completed': {
      const comp = event as import('@autopod/shared').PodCompletedEvent;
      const color = comp.finalStatus === 'complete' ? chalk.green.bold : chalk.red.bold;
      console.log(`${ts} ${color(`Pod ${comp.finalStatus}`)}`);
      break;
    }
    case 'pod.created': {
      const cr = event as import('@autopod/shared').PodCreatedEvent;
      console.log(`${ts} ${chalk.blue('Pod created:')} ${cr.pod.id.slice(0, 8)}`);
      break;
    }
    default:
      console.log(`${ts} ${chalk.dim(JSON.stringify(event))}`);
  }
}
