import chalk from 'chalk';
import type { Command } from 'commander';
import { clear, getCurrentUser, getMsalClient } from '../auth/token-manager.js';
import { writeCredentials } from '../config/credential-store.js';
import { withSpinner } from '../output/spinner.js';

export function registerAuthCommands(program: Command): void {
  program
    .command('login')
    .description('Authenticate with Azure Entra ID')
    .option('--device', 'Use device code flow (for headless/SSH environments)')
    .action(async (opts: { device?: boolean }) => {
      const msal = getMsalClient();

      if (opts.device) {
        console.log(chalk.dim('Starting device code flow...'));
        const token = await msal.acquireTokenByDeviceCode((msg) => {
          console.log(chalk.yellow(msg));
        });
        writeCredentials(token);
        console.log(chalk.green(`Logged in as ${token.displayName} (${token.email})`));
      } else {
        const token = await withSpinner('Opening browser for authentication...', async () => {
          return msal.acquireTokenInteractive();
        });
        writeCredentials(token);
        console.log(chalk.green(`Logged in as ${token.displayName} (${token.email})`));
      }
    });

  program
    .command('logout')
    .description('Clear stored credentials')
    .action(() => {
      clear();
      console.log(chalk.dim('Logged out.'));
    });

  program
    .command('whoami')
    .description('Show current authenticated user')
    .action(() => {
      const user = getCurrentUser();
      if (!user) {
        console.log(chalk.dim('Not logged in. Run: ap login'));
        process.exit(2);
      }

      console.log(`${chalk.bold('User:')}  ${user.displayName}`);
      console.log(`${chalk.bold('Email:')} ${user.email}`);
      console.log(`${chalk.bold('Roles:')} ${user.roles.join(', ') || 'none'}`);
      console.log(`${chalk.bold('Expires:')} ${new Date(user.expiresAt).toLocaleString()}`);
    });
}
