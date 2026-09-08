import { access, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { managedGit, managedGitArguments } from './source-git.js';

it('pins each reviewed local source as an exact Git safe directory', () => {
  expect(managedGitArguments('/attempt root', ['/reviewed mirror']).slice(0, 5)).toEqual([
    '--no-pager',
    '-c',
    'safe.directory=/attempt root',
    '-c',
    'safe.directory=/reviewed mirror',
  ]);
  expect(() => managedGitArguments('/attempt', ['relative/mirror'])).toThrow(
    'managed-git-safe-directory-invalid',
  );
  expect(() => managedGitArguments('/attempt', ['/reviewed/*'])).toThrow(
    'managed-git-safe-directory-invalid',
  );
});

it('exact-checkout trust keeps worker-controlled Git hooks disabled', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'managed git trust '));
  try {
    await managedGit(root, ['init']);
    await mkdir(path.join(root, '.git/hooks'), { recursive: true });
    await writeFile(
      path.join(root, '.git/hooks/pre-commit'),
      '#!/bin/sh\ntouch hook-ran\nexit 1\n',
      { mode: 0o755 },
    );
    await managedGit(root, [
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@invalid',
      'commit',
      '--allow-empty',
      '-m',
      'fixture',
    ]);
    expect(await managedGit(root, ['rev-parse', '--show-toplevel'])).toBe(await realpath(root));
    await expect(access(path.join(root, 'hook-ran'))).rejects.toThrow();
    await expect(
      managedGit(root, ['config', '--local', '--get', 'safe.directory']),
    ).rejects.toThrow();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
