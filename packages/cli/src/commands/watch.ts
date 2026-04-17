import chalk from 'chalk';
import type { Command } from 'commander';
import type { AutopodClient } from '../api/client.js';
import { withSpinner } from '../output/spinner.js';

export function registerWatchCommands(program: Command, getClient: () => AutopodClient): void {
  const watch = program.command('watch').description('Issue/work-item watcher management');

  // ap watch enable <profile>
  watch
    .command('enable <profile>')
    .description('Enable issue watching for a profile')
    .option('--label-prefix <prefix>', 'Label prefix to watch for', 'autopod')
    .action(async (profileName: string, opts: { labelPrefix: string }) => {
      const client = getClient();
      await withSpinner('Enabling issue watcher...', () =>
        client.updateProfile(profileName, {
          issueWatcherEnabled: true,
          issueWatcherLabelPrefix: opts.labelPrefix,
        }),
      );
      console.log(
        chalk.green(`Issue watcher enabled for "${profileName}" (prefix: ${opts.labelPrefix})`),
      );
    });

  // ap watch disable <profile>
  watch
    .command('disable <profile>')
    .description('Disable issue watching for a profile')
    .action(async (profileName: string) => {
      const client = getClient();
      await withSpinner('Disabling issue watcher...', () =>
        client.updateProfile(profileName, { issueWatcherEnabled: false }),
      );
      console.log(chalk.green(`Issue watcher disabled for "${profileName}".`));
    });

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
