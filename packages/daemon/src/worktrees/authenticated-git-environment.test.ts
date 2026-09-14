import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { authenticatedGitEnvironment } from './authenticated-git-environment.js';

const exec = promisify(execFile);
describe('daemon authenticated Git boundary', () => {
  afterEach(() => vi.unstubAllEnvs());
  it('does not inherit account keys or Git configuration from the daemon', () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'fixture-unrelated-key');
    vi.stubEnv('GIT_CONFIG_PARAMETERS', 'fixture-untrusted-configuration');
    vi.stubEnv('GIT_SSH_COMMAND', 'fixture-helper');
    const env = authenticatedGitEnvironment(
      'https://dev.azure.com/org/project/_git/test',
      'Bearer fixture',
    );
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.GIT_CONFIG_PARAMETERS).toBeUndefined();
    expect(env.GIT_SSH_COMMAND).toBeUndefined();
    expect(env.GIT_CONFIG_GLOBAL).toBe('/dev/null');
  });
  it.each([
    'http://example.com/repo',
    'ssh://example.com/repo',
    'https://user:pass@example.com/repo',
  ])('rejects unsafe credential transport %s', (remote) => {
    expect(() => authenticatedGitEnvironment(remote, 'Bearer fixture')).toThrow();
  });
  it('rejects a repository URL rewrite to an executable remote helper', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'autopod-git-boundary-'));
    try {
      await exec('git', ['init', root]);
      const marker = path.join(root, 'executed');
      const helper = path.join(root, 'helper.sh');
      await writeFile(helper, `#!/bin/sh\nprintf unsafe > '${marker}'\n`, { mode: 0o700 });
      await exec(
        'git',
        ['config', `url.ext::${helper}.insteadOf`, 'https://fixture.invalid/repo'],
        { cwd: root },
      );
      await expect(
        exec('git', ['ls-remote', 'https://fixture.invalid/repo'], {
          cwd: root,
          env: authenticatedGitEnvironment('https://fixture.invalid/repo', 'Bearer fixture'),
        }),
      ).rejects.toThrow("transport 'ext' not allowed");
      await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
