import chalk from 'chalk';
import type { Command } from 'commander';
import { AutopodClient } from '../api/client.js';
import { getToken } from '../auth/token-manager.js';
import * as configStore from '../config/config-store.js';
import { withSpinner } from '../output/spinner.js';

export function registerDaemonCommands(program: Command): void {
  program
    .command('connect <url>')
    .description('Connect to a daemon instance')
    .action(async (url: string) => {
      // Validate URL format
      try {
        new URL(url);
      } catch {
        console.error(chalk.red(`Invalid URL: ${url}`));
        process.exit(1);
      }

      configStore.set('daemon', url);

      // Try to reach it
      const client = new AutopodClient({ baseUrl: url, getToken });
      try {
        const health = await withSpinner('Connecting to daemon...', () => client.checkHealth());
        console.log(chalk.green(`Connected to daemon v${health.version} at ${url}`));
      } catch {
        console.log(chalk.yellow(`Saved ${url} but daemon is not reachable.`));
        console.log(chalk.dim('The daemon may not be running yet.'));
      }
    });

  program
    .command('disconnect')
    .description('Remove daemon connection')
    .action(() => {
      configStore.set('daemon', undefined);
      console.log(chalk.dim('Disconnected.'));
    });

  program
    .command('stop')
    .description('Gracefully stop the daemon')
    .action(async () => {
      const daemonUrl = configStore.get('daemon');
      if (!daemonUrl) {
        console.error(chalk.red('No daemon configured. Run: ap connect <url>'));
        process.exit(1);
      }

      const client = new AutopodClient({ baseUrl: daemonUrl, getToken });
      try {
        await withSpinner('Stopping daemon...', () => client.stopDaemon());
        console.log(chalk.green('Daemon is shutting down.'));
      } catch {
        console.error(chalk.red('Failed to reach daemon — it may already be stopped.'));
        process.exit(1);
      }
    });

  program
    .command('repair-token-telemetry')
    .description('Dry-run historical token telemetry repair (use --apply after review)')
    .option('--apply', 'Apply audited corrections instead of dry-run only')
    .option('--json', 'Print the complete machine-readable report')
    .action(async (options: { apply?: boolean; json?: boolean }) => {
      const daemonUrl = configStore.get('daemon');
      if (!daemonUrl) {
        console.error(chalk.red('No daemon configured. Run: ap connect <url>'));
        process.exitCode = 1;
        return;
      }
      const client = new AutopodClient({ baseUrl: daemonUrl, getToken });
      const report = await withSpinner(
        options.apply ? 'Applying telemetry repair...' : 'Scanning telemetry evidence...',
        () => client.repairTokenTelemetry(options.apply === true),
      );
      if (options.json) {
        console.log(JSON.stringify(report, null, 2));
        return;
      }
      console.log(
        `${options.apply ? chalk.green('Applied') : chalk.cyan('Dry run')}: ` +
          `${report.repairedPods} repairable, ${report.partialPods} partial, ` +
          `${report.skippedPods} skipped`,
      );
      for (const entry of report.entries) {
        const marker =
          entry.status === 'repaired'
            ? chalk.green('repaired')
            : entry.status === 'partial'
              ? chalk.yellow('partial')
              : chalk.dim('skipped');
        console.log(`  ${entry.podId}  ${marker}  ${entry.reason}`);
      }
      if (!options.apply && report.repairedPods > 0) {
        console.log(
          chalk.dim('Review this report, then rerun with --apply to persist corrections.'),
        );
      }
    });
}
