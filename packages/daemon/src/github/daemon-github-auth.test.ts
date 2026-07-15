import { describe, expect, it, vi } from 'vitest';
import {
  DAEMON_GITHUB_AUTH_SETUP,
  DaemonGitHubAuthError,
  GhCliDaemonGitHubAuth,
  type GhRunner,
} from './daemon-github-auth.js';

function authWith(runGh: GhRunner): GhCliDaemonGitHubAuth {
  return new GhCliDaemonGitHubAuth({ runGh, timeoutMs: 25 });
}

describe('GhCliDaemonGitHubAuth', () => {
  it('resolves an authenticated daemon GitHub credential', async () => {
    const runGh = vi.fn<GhRunner>().mockResolvedValue({ stdout: 'gho_daemon_token\n', stderr: '' });
    await expect(authWith(runGh).resolveCredential()).resolves.toEqual({
      token: 'gho_daemon_token',
      username: 'x-access-token',
    });
    expect(runGh).toHaveBeenCalledWith(['auth', 'token', '--hostname', 'github.com'], {
      timeout: 25,
    });
  });

  it('reports missing gh with setup guidance and no token output', async () => {
    const runGh = vi.fn<GhRunner>().mockRejectedValue(
      Object.assign(new Error('spawn gh ENOENT'), {
        code: 'ENOENT',
        stdout: 'gho_secret_should_not_leak',
        stderr: 'gho_secret_should_not_leak',
      }),
    );
    await expect(authWith(runGh).resolveCredential()).rejects.toMatchObject({
      code: 'GH_MISSING',
      message: expect.stringContaining(DAEMON_GITHUB_AUTH_SETUP),
    });
    await expect(authWith(runGh).resolveCredential()).rejects.not.toThrow(
      'gho_secret_should_not_leak',
    );
  });

  it('reports unauthenticated gh state distinctly', async () => {
    const runGh = vi.fn<GhRunner>().mockRejectedValue(
      Object.assign(new Error('exit 1'), {
        code: 1,
        stderr: 'not logged in to github.com',
      }),
    );
    await expect(authWith(runGh).resolveCredential()).rejects.toMatchObject({
      code: 'GH_UNAUTHENTICATED',
    });
  });

  it('rejects empty token output', async () => {
    const runGh = vi.fn<GhRunner>().mockResolvedValue({ stdout: '\n', stderr: '' });
    await expect(authWith(runGh).resolveCredential()).rejects.toMatchObject({
      code: 'GH_TOKEN_EMPTY',
    });
  });

  it('rejects malformed token output', async () => {
    const runGh = vi
      .fn<GhRunner>()
      .mockResolvedValue({ stdout: 'gho_first\ngho_second\n', stderr: '' });
    await expect(authWith(runGh).resolveCredential()).rejects.toMatchObject({
      code: 'GH_TOKEN_MALFORMED',
    });
  });

  it('reports timeout distinctly', async () => {
    const runGh = vi.fn<GhRunner>().mockRejectedValue(
      Object.assign(new Error('timed out'), {
        killed: true,
        signal: 'SIGTERM',
      }),
    );
    await expect(authWith(runGh).resolveCredential()).rejects.toMatchObject({
      code: 'GH_TIMEOUT',
    });
  });

  it('returns secret-safe status with login when discoverable', async () => {
    const runGh = vi
      .fn<GhRunner>()
      .mockResolvedValueOnce({ stdout: 'github_pat_secret\n', stderr: '' })
      .mockResolvedValueOnce({ stdout: 'autopod-dev\n', stderr: '' });
    const status = await authWith(runGh).getStatus();
    expect(status).toEqual({
      available: true,
      login: 'autopod-dev',
      setup: DAEMON_GITHUB_AUTH_SETUP,
    });
    expect(JSON.stringify(status)).not.toContain('github_pat_secret');
  });

  it('uses typed auth errors', async () => {
    const err = new DaemonGitHubAuthError('missing auth', 'GH_UNAUTHENTICATED');
    expect(err.message).toContain(DAEMON_GITHUB_AUTH_SETUP);
    expect(err.code).toBe('GH_UNAUTHENTICATED');
  });
});
