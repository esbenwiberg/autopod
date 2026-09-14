import chalk from 'chalk';
import type { Command } from 'commander';
import type { AutopodClient } from '../api/client.js';
import { withSpinner } from '../output/spinner.js';

export function registerWatchCommands(program: Command, getClient: () => AutopodClient): void {
  const watch = program.command('watch').description('Issue/work-item watcher management');

  for (const enabled of [true, false]) {
    watch
      .command(`${enabled ? 'enable' : 'disable'} <watcher>`)
      .description(`${enabled ? 'Enable' : 'Pause'} a configured repository watcher`)
      .option('--label-prefix <prefix>', 'Explicitly change the watched label prefix')
      .action(async (name: string, opts: { labelPrefix?: string }) => {
        const client = getClient();
        const bindings = await client.listWatcherBindings();
        const matches = bindings.filter(
          (entry) => entry.id === name || entry.payload.name === name,
        );
        if (matches.length !== 1 || !matches[0])
          throw new Error('Select a unique watcher ID or name from ap watcher list.');
        const current = matches[0];
        await withSpinner('Updating repository watcher...', () =>
          client.writeWatcherBinding({
            id: current.id,
            expectedRevision: current.revision,
            payload: {
              ...current.payload,
              enabled,
              ...(opts.labelPrefix ? { labelPrefix: opts.labelPrefix } : {}),
            },
          }),
        );
        console.log(
          chalk.green(`Watcher "${current.payload.name}" ${enabled ? 'enabled' : 'paused'}.`),
        );
      });
  }

  // ap watch issues
  watch
    .command('issues')
    .description('List tracked issues')
    .option('--profile <name>', 'Filter by profile')
    .option('--status <status>', 'Filter by status (in_progress, done, failed)')
    .option('--json', 'Output as JSON')
    .action(async (opts: { profile?: string; status?: string; json?: boolean }) => {
      const client = getClient();
      const issues = await client.listWatchedIssues({
        profile: opts.profile,
        status: opts.status,
      });

      if (opts.json) {
        console.log(JSON.stringify(issues, null, 2));
        return;
      }

      if (issues.length === 0) {
        console.log(chalk.dim('No tracked issues found.'));
        return;
      }

      for (const issue of issues) {
        const statusColor =
          issue.status === 'done'
            ? chalk.green
            : issue.status === 'failed'
              ? chalk.red
              : chalk.yellow;

        console.log(
          `${statusColor(`[${issue.status}]`)} ${chalk.bold(issue.issueTitle)} ` +
            `${chalk.dim(`(${issue.provider} #${issue.issueId})`)}`,
        );
        console.log(`  Profile: ${issue.profileName}  Pod: ${issue.podId ?? 'n/a'}`);
        console.log(`  ${chalk.dim(issue.issueUrl)}`);
        console.log();
      }
    });
}
