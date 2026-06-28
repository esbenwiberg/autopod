import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import chalk from 'chalk';
import type { Command } from 'commander';
import * as configStore from '../config/config-store.js';

const execFileAsync = promisify(execFile);

const APP_PATH = '/Applications/Autopod.app';
const APP_EXECUTABLE_PATH = `${APP_PATH}/Contents/MacOS/Autopod`;

/**
 * Build the `autopod://connect` deep link the desktop app handles on launch
 * (see ConnectionManager.handleDeepLink in packages/desktop). The app upserts
 * the connection by URL and connects.
 */
export function buildConnectDeepLink(opts: {
  url: string;
  name?: string;
  authKind?: 'manualToken' | 'entra';
  token?: string;
}): string {
  const params = new URLSearchParams({ url: opts.url });
  if (opts.name) params.set('name', opts.name);
  if (opts.authKind) params.set('authKind', opts.authKind);
  if (opts.token) params.set('token', opts.token);
  return `autopod://connect?${params.toString()}`;
}

/** Walk up from this module to locate scripts/install-desktop.sh in the repo. */
function findInstallScript(): string | null {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 12; i++) {
    const candidate = join(dir, 'scripts', 'install-desktop.sh');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/** Run the install script with inherited stdio so xcodebuild output streams. */
function runInstallScript(script: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('bash', [script], { stdio: 'inherit' });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`install-desktop.sh exited with code ${code ?? 'unknown'}`));
    });
  });
}

export function findStoppedDesktopProcessIds(psOutput: string): string[] {
  return findDesktopProcesses(psOutput)
    .filter((process) => process.stat.includes('T'))
    .map((process) => process.pid);
}

function findDesktopProcesses(psOutput: string): Array<{ pid: string; stat: string }> {
  const processes: Array<{ pid: string; stat: string }> = [];
  for (const line of psOutput.split('\n')) {
    const match = line.match(/^\s*(\d+)\s+(\S+)\s+(.+)$/);
    if (!match) continue;
    const [, pid, stat, command] = match;
    if (pid && stat && command?.startsWith(APP_EXECUTABLE_PATH)) {
      processes.push({ pid, stat });
    }
  }
  return processes;
}

function execStdoutToString(result: Awaited<ReturnType<typeof execFileAsync>>): string {
  return typeof result === 'string' ? result : String(result.stdout);
}

async function readDesktopProcessIds(): Promise<string[]> {
  try {
    const result = await execFileAsync('pgrep', ['-f', APP_EXECUTABLE_PATH]);
    return execStdoutToString(result)
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => /^\d+$/.test(line));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 1) return [];
    throw err;
  }
}

async function readDesktopProcesses(): Promise<Array<{ pid: string; stat: string }>> {
  const processIds = await readDesktopProcessIds();
  if (processIds.length === 0) return [];
  const result = await execFileAsync('ps', [
    '-p',
    processIds.join(','),
    '-o',
    'pid=,stat=,command=',
  ]);
  return findDesktopProcesses(execStdoutToString(result));
}

async function resumeStoppedDesktopProcesses(
  processes: Array<{ pid: string; stat: string }>,
): Promise<number> {
  let resumed = 0;
  for (const desktopProcess of processes) {
    if (!desktopProcess.stat.includes('T')) continue;
    const pid = Number.parseInt(desktopProcess.pid, 10);
    if (Number.isNaN(pid)) continue;
    try {
      process.kill(pid, 'SIGCONT');
      resumed++;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ESRCH') throw err;
    }
  }
  return resumed;
}

async function waitForDesktopToRun(timeoutMs: number, intervalMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastStoppedCount = 0;

  do {
    let processes: Array<{ pid: string; stat: string }>;
    try {
      processes = await readDesktopProcesses();
    } catch {
      // Best-effort only. On normal launches there is nothing to resume, and if
      // process inspection is unavailable the app can still consume argv/defaults.
      return;
    }

    lastStoppedCount = processes.filter((process) => process.stat.includes('T')).length;

    if (lastStoppedCount > 0) {
      await resumeStoppedDesktopProcesses(processes);
    } else if (processes.length > 0) {
      return;
    }

    if (timeoutMs <= 0) return;
    await delay(intervalMs);
  } while (Date.now() < deadline);

  if (lastStoppedCount > 0) {
    throw new Error('Autopod launched but remained stopped before startup completed.');
  }
}

async function writePendingDeepLink(deepLink: string): Promise<void> {
  await execFileAsync('defaults', [
    'write',
    'com.autopod.desktop',
    'autopod.pendingDeepLink',
    deepLink,
  ]);
}

export async function launchDesktopApp(
  deepLink: string,
  opts: { settleMs?: number; launchTimeoutMs?: number } = {},
): Promise<void> {
  const settleMs = opts.settleMs ?? 150;
  const launchTimeoutMs = opts.launchTimeoutMs ?? 3_000;

  // Store the connect request before launch. Passing it via defaults/argv avoids
  // a second LaunchServices URL dispatch, which can fail with -600 on local
  // unsigned "Sign to Run Locally" builds while the app is still checking in.
  await writePendingDeepLink(deepLink);
  await execFileAsync('open', [APP_PATH, '--args', deepLink]);
  await waitForDesktopToRun(launchTimeoutMs, settleMs);
}

export function registerDesktopCommands(program: Command): void {
  program
    .command('desktop')
    .description('Build (if needed), launch, and connect the macOS app to your daemon')
    .option('--build', 'Force a rebuild even if the app is already installed')
    .option('--no-launch', 'Build/install only; do not launch')
    .option('--url <url>', 'Daemon URL to connect to (defaults to the configured daemon)')
    .action(async (opts: { build?: boolean; launch?: boolean; url?: string }) => {
      if (process.platform !== 'darwin') {
        console.error(chalk.red('The Autopod desktop app is macOS-only.'));
        process.exit(1);
        return;
      }

      const daemonUrl = opts.url ?? configStore.get('daemon');
      if (!daemonUrl) {
        console.error(chalk.red('No daemon configured. Run: ap connect <url>'));
        process.exit(1);
        return;
      }

      // Build/install when the app is missing or a rebuild was requested.
      const installed = existsSync(APP_PATH);
      if (!installed || opts.build) {
        const script = findInstallScript();
        if (!script) {
          console.error(
            chalk.red(
              'Could not find scripts/install-desktop.sh — run `ap desktop` from the repo.',
            ),
          );
          process.exit(1);
          return;
        }
        console.log(
          chalk.dim(
            installed ? 'Rebuilding desktop app…' : 'Desktop app not installed — building…',
          ),
        );
        try {
          await runInstallScript(script);
        } catch (err) {
          console.error(chalk.red((err as Error).message));
          process.exit(1);
          return;
        }
      }

      if (opts.launch === false) {
        console.log(chalk.green('Installed. Skipping launch (--no-launch).'));
        return;
      }

      // For non-local daemons the app signs in via Entra itself; local daemons
      // resolve the dev token on disk, so we never put a token in the URL.
      let authKind: 'manualToken' | 'entra' = 'manualToken';
      try {
        const host = new URL(daemonUrl).hostname;
        const isLocal = host === 'localhost' || host === '127.0.0.1' || host === '::1';
        if (!isLocal) authKind = 'entra';
      } catch {
        // Malformed URL — let the app surface the error after launch.
      }

      const deepLink = buildConnectDeepLink({
        url: daemonUrl,
        ...(authKind === 'entra' ? { authKind } : {}),
      });

      try {
        await launchDesktopApp(deepLink);
        console.log(chalk.green(`Launched Autopod → connecting to ${daemonUrl}`));
      } catch (err) {
        console.error(chalk.red(`Failed to launch desktop app: ${(err as Error).message}`));
        process.exit(1);
      }
    });
}
