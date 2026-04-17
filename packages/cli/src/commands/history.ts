import chalk from 'chalk';
import type { Command } from 'commander';
import type { AutopodClient } from '../api/client.js';
import { formatStatus } from '../output/colors.js';
import { withSpinner } from '../output/spinner.js';

/**
 * Parse a relative duration string (e.g. "7d", "30d", "2w") into an ISO date string.
 * Also accepts ISO dates directly.
 */
function parseSince(value: string): string {
  // Already an ISO date?
  if (/^\d{4}-\d{2}-\d{2}/.test(value)) return value;

  const match = value.match(/^(\d+)([dhwm])$/);
  if (!match) return value;

  const amount = Number.parseInt(match[1], 10);
  const unit = match[2];
  const now = new Date();

  switch (unit) {
    case 'd':
      now.setDate(now.getDate() - amount);
      break;
    case 'h':
      now.setHours(now.getHours() - amount);
      break;
    case 'w':
      now.setDate(now.getDate() - amount * 7);
      break;
    case 'm':
      now.setMonth(now.getMonth() - amount);
      break;
  }

  return now.toISOString();
}

export function registerHistoryCommands(program: Command, getClient: () => AutopodClient): void {
  program
    .command('history <profile>')
    .description(
      'Create a history analysis workspace — an interactive container with pod history data',
    )
    .option('--since <duration>', 'Only include pods since (e.g. 7d, 30d, 2w, 2026-01-01)')
    .option('--failures', 'Only include failed/killed pods')
    .option('--limit <n>', 'Max pods to include (default: 100)', (v) => Number.parseInt(v, 10))
    .action(
      async (profile: string, opts: { since?: string; failures?: boolean; limit?: number }) => {
        const client = getClient();

        const pod = await withSpinner('Creating history workspace...', () =>
          client.createHistoryWorkspace({
            profileName: profile,
            since: opts.since ? parseSince(opts.since) : undefined,
            limit: opts.limit,
            failuresOnly: opts.failures,
          }),
        );

        console.log(chalk.green(`History workspace ${chalk.bold(pod.id)} created.`));
        console.log(`${chalk.bold('Profile:')}  ${pod.profileName}`);
        console.log(`${chalk.bold('Status:')}   ${formatStatus(pod.status)}`);
        console.log(`${chalk.bold('Branch:')}   ${pod.branch}`);
        console.log();
        console.log(chalk.bold('Enter the container:'));
        console.log(`  ${chalk.cyan(`ap attach ${pod.id.slice(0, 8)}`)}`);
        console.log();
        console.log(chalk.dim('Inside the container:'));
        console.log(chalk.dim('  /history/history.db         SQLite database with pod data'));
        console.log(chalk.dim('  /history/summary.md         Overview and stats'));
        console.log(chalk.dim('  /history/analysis-guide.md  Example queries and analysis tips'));
        console.log(chalk.dim('  /workspace/CLAUDE.md        Instructions for Claude Code'));
      },
    );
}
