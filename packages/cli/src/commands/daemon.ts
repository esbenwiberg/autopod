import type { Command } from 'commander';
import chalk from 'chalk';
import * as configStore from '../config/config-store.js';
import { AutopodClient } from '../api/client.js';
import { getToken } from '../auth/token-manager.js';
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
        const health = await withSpinner('Connecting to daemon...', () =>
          client.checkHealth(),
        );
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
}
