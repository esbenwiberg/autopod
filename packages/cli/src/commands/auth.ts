import { spawn } from 'node:child_process';
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
    .command('token')
    .description('Print the current Entra access token')
    .option('--copy', 'Copy the token to the clipboard instead of printing it')
    .action(async (opts: { copy?: boolean }) => {
      const user = getCurrentUser();
      if (!user?.accessToken) {
        console.error(chalk.red('Not authenticated. Run: ap login'));
        process.exit(2);
      }

      if (opts.copy) {
        try {
          await copyTextToClipboard(user.accessToken);
          console.log(chalk.green('Access token copied to clipboard.'));
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          console.error(chalk.red(message));
          process.exit(1);
        }
        return;
      }

      process.stdout.write(`${user.accessToken}\n`);
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

async function copyTextToClipboard(text: string): Promise<void> {
  const commands = clipboardCommands();
  if (commands.length === 0) {
    throw new Error('Clipboard copy is not supported on this platform. Run: ap token | pbcopy');
  }

  let lastError: Error | undefined;

  for (const [command, args] of commands) {
    try {
      await writeToClipboard(command, args, text);
      return;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
    }
  }

  const tools = commands.map(([command]) => command).join(', ');
  throw new Error(
    `Could not copy token to clipboard. Install one of: ${tools}. ${
      lastError?.message ?? ''
    }`.trim(),
  );
}

function clipboardCommands(): [string, string[]][] {
  if (process.platform === 'darwin') return [['pbcopy', []]];
  if (process.platform === 'win32') return [['clip', []]];
  if (process.platform === 'linux') {
    return [
      ['wl-copy', []],
      ['xclip', ['-selection', 'clipboard']],
      ['xsel', ['--clipboard', '--input']],
    ];
  }
  return [];
}

function writeToClipboard(command: string, args: string[], text: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['pipe', 'ignore', 'ignore'] });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited with code ${code ?? 'unknown'}`));
    });
    child.stdin.end(text);
  });
}
