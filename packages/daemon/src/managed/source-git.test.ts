import { execFileSync } from 'node:child_process';
import { access, chmod, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import {
  ManagedGitBroker,
  managedGit,
  managedGitArguments,
  managedGitAuthorizationHeader,
  managedGitConfigContents,
} from './source-git.js';

it('uses an explicit GitHub Basic transport without changing the bearer default', () => {
  expect(
    managedGitAuthorizationHeader({
      url: 'https://github.com/example/private.git',
      token: 'short-lived-token',
    }),
  ).toBe('Authorization: Bearer short-lived-token');
  expect(
    managedGitAuthorizationHeader({
      url: 'https://github.com/example/private.git',
      token: 'short-lived-token',
      mode: 'github-basic',
    }),
  ).toBe(
    `Authorization: Basic ${Buffer.from('x-access-token:short-lived-token').toString('base64')}`,
  );
  expect(() =>
    managedGitAuthorizationHeader({
      url: 'https://dev.azure.com/example/private',
      token: 'short-lived-token',
      mode: 'github-basic',
    }),
  ).toThrow('managed-git-credential-mode-mismatch');
  expect(() =>
    managedGitAuthorizationHeader({
      url: 'https://github.com/example/private.git',
      token: 'invalid\ntoken',
      mode: 'github-basic',
    }),
  ).toThrow('managed-git-credential-invalid');
});

it('rejects a GitHub credential mode enrolled for another provider', () => {
  const broker = new ManagedGitBroker([
    {
      repository: 'fixture',
      remote: 'origin',
      remoteUrl: 'https://dev.azure.com/example/private',
      base: 'main',
      baseCommit: 'a'.repeat(40),
      branchNamespace: 'worker/',
      credentialMode: 'github-basic',
      workspace: () => '/attempt',
    },
  ]);
  expect(() =>
    broker.binding({ repository: 'fixture', remote: 'origin', head: 'worker/one', base: 'main' }),
  ).toThrow('source-credential-mode-mismatch');
});

it('pins each reviewed local source in command and inherited config trust', async () => {
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
  const config = managedGitConfigContents('/attempt root', ['/reviewed mirror']);
  expect(config).toBe('[safe]\n\tdirectory = "/attempt root"\n\tdirectory = "/reviewed mirror"\n');
  const root = await mkdtemp(path.join(tmpdir(), 'managed git config '));
  try {
    const file = path.join(root, 'config');
    await writeFile(file, config);
    expect(
      execFileSync('git', ['config', '--file', file, '--get-all', 'safe.directory'], {
        encoding: 'utf8',
      })
        .trim()
        .split('\n'),
    ).toEqual(['/attempt root', '/reviewed mirror']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
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

it('deterministically commits a successful worker dirty tree before freezing', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'managed git recovery '));
  const remote = path.join(root, 'remote.git');
  const workspace = path.join(root, 'workspace');
  try {
    await managedGit(root, ['init', '--bare', remote]);
    await managedGit(root, ['init', '-b', 'main', workspace]);
    await writeFile(path.join(workspace, 'tracked.txt'), 'base\n');
    await managedGit(workspace, ['add', '.']);
    await managedGit(workspace, [
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@invalid',
      'commit',
      '-m',
      'base',
    ]);
    const base = await managedGit(workspace, ['rev-parse', 'HEAD']);
    await managedGit(workspace, ['push', remote, 'main']);

    await writeFile(path.join(workspace, 'tracked.txt'), 'changed\n');
    await writeFile(path.join(workspace, 'new.txt'), 'new\n');
    await chmod(path.join(workspace, 'tracked.txt'), 0o755);
    await mkdir(path.join(workspace, '.git', 'hooks'), { recursive: true });
    await writeFile(
      path.join(workspace, '.git', 'hooks', 'pre-commit'),
      '#!/bin/sh\ntouch hook-ran\nexit 1\n',
      { mode: 0o755 },
    );
    await managedGit(workspace, ['config', '--local', 'commit.gpgSign', 'true']);

    const broker = new ManagedGitBroker([
      {
        repository: 'fixture',
        remote: 'origin',
        remoteUrl: remote,
        base: 'main',
        baseCommit: base,
        branchNamespace: 'worker/',
        workspace: () => workspace,
      },
    ]);
    const frozen = await broker.freeze('managed-fixture', {
      repository: 'fixture',
      remote: 'origin',
      head: 'worker/recovered',
      base: 'main',
    });

    expect(frozen.newCommit).not.toBe(base);
    expect(frozen.expectedOldCommit).toBe('0'.repeat(40));
    expect(frozen.bundle.length).toBeGreaterThan(0);
    expect(await managedGit(workspace, ['status', '--porcelain', '--untracked-files=all'])).toBe(
      '',
    );
    expect(await managedGit(workspace, ['show', '-s', '--format=%an <%ae>%n%s', 'HEAD'])).toBe(
      'Autopod <autopod@autopod.local>\nchore: capture managed worker changes',
    );
    expect(await managedGit(workspace, ['show', '--format=', '--name-only', 'HEAD'])).toContain(
      'new.txt',
    );
    await expect(access(path.join(workspace, 'hook-ran'))).rejects.toThrow();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
