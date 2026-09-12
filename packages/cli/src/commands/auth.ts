import { spawn } from 'node:child_process';
import chalk from 'chalk';
import type { Command } from 'commander';
import { parseAuthScopes } from '../auth/auth-config.js';
import { clear, getCurrentUser, getMsalClient, getToken, initMsal } from '../auth/token-manager.js';
import * as configStore from '../config/config-store.js';
import { writeCredentials } from '../config/credential-store.js';
import { withSpinner } from '../output/spinner.js';

interface LoginOptions {
  browser?: boolean;
  device?: boolean;
  clientId?: string;
  tenantId?: string;
  scope?: string[];
}

export function registerAuthCommands(program: Command): void {
  program
    .command('login')
    .description('Authenticate with Azure Entra ID')
    .option('--device', 'Use device code flow (for headless/SSH environments)')
    .option('--browser', 'Force the local browser callback flow')
    .option('--client-id <id>', 'Persist the Entra application/client ID for future logins')
    .option('--tenant-id <id>', 'Persist the Entra tenant ID for future logins')
    .option(
      '--scope <scope>',
      'Persist an auth scope for future logins; repeat for multiple scopes',
      collectScopes,
      [] as string[],
    )
    .action(async (opts: LoginOptions) => {
      configureMsalFromLoginOptions(opts);

      const configurationChanged = Boolean(
        opts.clientId || opts.tenantId || (opts.scope && opts.scope.length > 0),
      );
      if (!opts.device && !opts.browser && !configurationChanged) {
        try {
          await getToken();
          const current = getCurrentUser();
          if (current) {
            console.log(
              chalk.green(`Already logged in as ${current.displayName} (${current.email})`),
            );
            return;
          }
        } catch {
          // Continue to browser SSO when no refreshable session is available.
        }
      }

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
          const daemonUrl = configStore.get('daemon');
          if (
            shouldUseBrokeredLogin(opts, process.env, process.stdin.isTTY, process.stdout.isTTY)
          ) {
            if (!daemonUrl) throw new Error('No daemon configured for brokered authentication');
            return msal.acquireTokenBrokered(daemonUrl);
          }
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
    .description('Print the daemon access token')
    .option('--copy', 'Copy the token to the clipboard instead of printing it')
    .action(async (opts: { copy?: boolean }) => {
      let accessToken: string;
      try {
        accessToken = await getToken();
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Not authenticated. Run: ap login';
        console.error(chalk.red(message));
        process.exit(2);
      }

      if (opts.copy) {
        try {
          await copyTextToClipboard(accessToken);
          console.log(chalk.green('Access token copied to clipboard.'));
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          console.error(chalk.red(message));
          process.exit(1);
        }
        return;
      }

      process.stdout.write(`${accessToken}\n`);
    });

  program
    .command('whoami')
    .description('Show current authenticated user')
    .action(async () => {
      let accessError: Error | null = null;
      try {
        await getToken();
      } catch (error) {
        accessError = error instanceof Error ? error : new Error(String(error));
      }
      const user = getCurrentUser({ allowExpired: accessError !== null });
      if (!user) {
        console.log(chalk.dim('Not logged in. Run: ap login'));
        process.exit(2);
      }

      console.log(`${chalk.bold('User:')}  ${user.displayName}`);
      console.log(`${chalk.bold('Email:')} ${user.email}`);
      console.log(`${chalk.bold('Roles:')} ${user.roles.join(', ') || 'none'}`);
      if (accessError) {
        console.log(`${chalk.bold('Access:')} unavailable (${accessError.message})`);
        process.exit(2);
      }
      console.log(`${chalk.bold('Expires:')} ${new Date(user.expiresAt).toLocaleString()}`);
    });
}

export function shouldUseBrokeredLogin(
  opts: Pick<LoginOptions, 'browser'>,
  env: NodeJS.ProcessEnv = process.env,
  stdinIsTty = process.stdin.isTTY,
  stdoutIsTty = process.stdout.isTTY,
): boolean {
  if (opts.browser) return false;
  return env.CODEX_SANDBOX !== undefined || stdinIsTty !== true || stdoutIsTty !== true;
}

function configureMsalFromLoginOptions(opts: LoginOptions): void {
  if (!opts.clientId && !opts.tenantId && (!opts.scope || opts.scope.length === 0)) return;
  if (!opts.clientId || !opts.tenantId) {
    throw new Error('--client-id and --tenant-id must be provided together');
  }

  const current = configStore.getAll();
  const scopes = parseAuthScopes(opts.scope, opts.clientId);
  configStore.setAll({
    ...current,
    auth: {
      clientId: opts.clientId,
      tenantId: opts.tenantId,
      ...(opts.scope && opts.scope.length > 0 ? { scopes } : {}),
    },
  });
  initMsal(opts.clientId, opts.tenantId, scopes);
}

function collectScopes(scope: string, scopes: string[]): string[] {
  scopes.push(scope);
  return scopes;
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
