import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export const DAEMON_GITHUB_AUTH_SETUP =
  'Log in as the daemon service account with: sudo -u <daemon-user> gh auth login --hostname github.com --git-protocol https';

export type DaemonGitHubAuthStatus =
  | { available: true; login: string | null; setup: string }
  | { available: false; reason: string; setup: string };

export interface DaemonGitHubCredential {
  token: string;
  username: string;
}

export interface DaemonGitHubAuth {
  resolveCredential(): Promise<DaemonGitHubCredential>;
  getStatus(): Promise<DaemonGitHubAuthStatus>;
}

export type GhRunner = (
  args: string[],
  options: { timeout: number },
) => Promise<{ stdout: string; stderr: string }>;

export class DaemonGitHubAuthError extends Error {
  constructor(
    message: string,
    public readonly code:
      | 'GH_MISSING'
      | 'GH_UNAUTHENTICATED'
      | 'GH_TOKEN_EMPTY'
      | 'GH_TOKEN_MALFORMED'
      | 'GH_TIMEOUT'
      | 'GH_REJECTED',
  ) {
    super(`${message}. ${DAEMON_GITHUB_AUTH_SETUP}`);
    this.name = 'DaemonGitHubAuthError';
  }
}

export class GhCliDaemonGitHubAuth implements DaemonGitHubAuth {
  private readonly runGh: GhRunner;
  private readonly timeoutMs: number;

  constructor(config: { runGh?: GhRunner; timeoutMs?: number } = {}) {
    this.runGh = config.runGh ?? defaultGhRunner;
    this.timeoutMs = config.timeoutMs ?? 10_000;
  }

  async resolveCredential(): Promise<DaemonGitHubCredential> {
    const token = await this.resolveToken();
    await this.resolveLogin().catch((err) => {
      throw mapGhFailure(err);
    });
    return { token, username: 'x-access-token' };
  }

  async getStatus(): Promise<DaemonGitHubAuthStatus> {
    try {
      await this.resolveToken();
      const login = await this.resolveLogin().catch((err) => {
        throw mapGhFailure(err);
      });
      if (!login) {
        throw new DaemonGitHubAuthError(
          'GitHub CLI returned an empty authenticated login',
          'GH_REJECTED',
        );
      }
      return { available: true, login, setup: DAEMON_GITHUB_AUTH_SETUP };
    } catch (err) {
      return {
        available: false,
        reason: err instanceof Error ? err.message : String(err),
        setup: DAEMON_GITHUB_AUTH_SETUP,
      };
    }
  }

  private async resolveToken(): Promise<string> {
    let result: { stdout: string; stderr: string };
    try {
      result = await this.runGh(['auth', 'token', '--hostname', 'github.com'], {
        timeout: this.timeoutMs,
      });
    } catch (err) {
      throw mapGhFailure(err);
    }

    const token = result.stdout.trim();
    if (!token) {
      throw new DaemonGitHubAuthError(
        'GitHub CLI authentication returned an empty token',
        'GH_TOKEN_EMPTY',
      );
    }
    if (/\s/.test(token)) {
      throw new DaemonGitHubAuthError(
        'GitHub CLI authentication returned malformed token output',
        'GH_TOKEN_MALFORMED',
      );
    }
    return token;
  }

  private async resolveLogin(): Promise<string | null> {
    const result = await this.runGh(['api', 'user', '--jq', '.login'], {
      timeout: this.timeoutMs,
    });
    return result.stdout.trim() || null;
  }
}

async function defaultGhRunner(
  args: string[],
  options: { timeout: number },
): Promise<{ stdout: string; stderr: string }> {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => key !== 'GH_TOKEN' && key !== 'GITHUB_TOKEN'),
  );
  const { stdout, stderr } = await execFileAsync('gh', args, {
    timeout: options.timeout,
    windowsHide: true,
    env,
  });
  return { stdout, stderr };
}

function mapGhFailure(err: unknown): DaemonGitHubAuthError {
  const record = err as {
    code?: unknown;
    signal?: unknown;
    killed?: unknown;
    stderr?: unknown;
    message?: unknown;
  };
  if (record.code === 'ENOENT') {
    return new DaemonGitHubAuthError(
      'GitHub CLI (`gh`) is not installed or not on PATH',
      'GH_MISSING',
    );
  }
  if (record.signal === 'SIGTERM' || record.killed === true) {
    return new DaemonGitHubAuthError('GitHub CLI authentication timed out', 'GH_TIMEOUT');
  }

  const stderr = typeof record.stderr === 'string' ? record.stderr : '';
  const message = typeof record.message === 'string' ? record.message : '';
  const combined = `${message}\n${stderr}`;
  if (/not logged in|no oauth token|authentication required|not authenticated/i.test(combined)) {
    return new DaemonGitHubAuthError(
      'GitHub CLI is not authenticated for the daemon service account',
      'GH_UNAUTHENTICATED',
    );
  }
  if (/\b(401|403)\b|bad credentials|requires authentication|insufficient/i.test(combined)) {
    return new DaemonGitHubAuthError(
      'GitHub CLI authentication was rejected by GitHub',
      'GH_REJECTED',
    );
  }
  return new DaemonGitHubAuthError(
    'GitHub CLI authentication is unavailable for the daemon service account',
    'GH_UNAUTHENTICATED',
  );
}
