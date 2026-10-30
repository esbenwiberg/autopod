import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockContainerManager, logger } from '../test-utils/mock-helpers.js';
import {
  ValidationWorkspaceReconcileError,
  createValidationWorkspace,
} from './validation-workspace.js';
import { createWorkspaceTransfer } from './workspace-transfer.js';

const run = promisify(execFile);

async function git(cwd: string, args: string[]) {
  return (await run('git', args, { cwd, timeout: 5_000 })).stdout.trim();
}

async function identity(cwd: string) {
  const status = await git(cwd, ['status', '--porcelain']);
  const gitDir = path.resolve(cwd, await git(cwd, ['rev-parse', '--git-dir']));
  return {
    head: await git(cwd, ['rev-parse', 'HEAD']),
    tree: await git(cwd, ['rev-parse', 'HEAD^{tree}']),
    status,
    index: createHash('sha256')
      .update(await readFile(path.join(gitDir, 'index')))
      .digest('hex'),
  };
}

async function commit(cwd: string, files: Record<string, string>, message: string) {
  for (const [name, bytes] of Object.entries(files)) await writeFile(path.join(cwd, name), bytes);
  await git(cwd, ['add', '.']);
  await git(cwd, ['commit', '-m', message]);
  return git(cwd, ['rev-parse', 'HEAD']);
}

/** Independent stores by default; only the local sync test opts into alternates. */
async function fixture(root: string) {
  const seed = path.join(root, 'seed');
  const bare = path.join(root, 'repo.git');
  const host = path.join(root, 'host');
  const workspace = path.join(root, 'container');
  const containerTmp = path.join(root, 'container-tmp');
  await mkdir(containerTmp);
  await git(root, ['init', '--initial-branch=main', seed]);
  const base = await commit(seed, { 'root.txt': 'baseline\n' }, 'baseline');
  await git(root, ['clone', '--bare', seed, bare]);
  await git(root, ['--git-dir', bare, 'worktree', 'add', '-b', 'feature', host, 'main']);
  await git(root, ['clone', '--no-hardlinks', bare, workspace]);
  await git(workspace, ['checkout', '-b', 'feature', 'main']);
  await expect(lstat(path.join(workspace, '.git/objects/info/alternates'))).rejects.toThrow();
  await expect(lstat(path.join(bare, 'objects/info/alternates'))).rejects.toThrow();
  const cm = createMockContainerManager();
  const uploads: Buffer[] = [];
  const remoteFile = (remote: string) => {
    if (!/^\/tmp\/autopod-reconcile-[\w-]+\.bundle$/.test(remote)) {
      throw new Error('Unexpected container temporary path');
    }
    return path.join(containerTmp, path.basename(remote));
  };
  cm.writeFile = vi.fn(async (_id, remote, content) => {
    const bytes = Buffer.from(content);
    uploads.push(bytes);
    await writeFile(remoteFile(remote), bytes);
  });
  cm.execInContainer = vi.fn(async (_id, command) => {
    const mapped = command.map((part) => {
      if (part.startsWith('/tmp/autopod-reconcile-')) return remoteFile(part);
      return part.replaceAll('/workspace', workspace).replaceAll('/mnt/worktree', host);
    });
    const executable = mapped[0];
    if (!executable) throw new Error('Empty container command');
    try {
      const result = await run(executable, mapped.slice(1), { timeout: 5_000 });
      return { stdout: result.stdout, stderr: result.stderr, exitCode: 0 };
    } catch (error) {
      const failure = error as { stdout?: string; stderr?: string; code?: number };
      return {
        stdout: failure.stdout ?? '',
        stderr: failure.stderr ?? String(error),
        exitCode: typeof failure.code === 'number' ? failure.code : 1,
      };
    }
  });
  const sync = vi.fn(async () => {
    throw new Error('Unexpected synchronization');
  });
  const preparation = createValidationWorkspace({ logger, syncWorkspaceBack: sync });
  return { root, seed, bare, host, workspace, containerTmp, base, cm, uploads, sync, preparation };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

async function diverge(f: Fixture, importContainer = true, equalTree = false) {
  const containerHead = await commit(
    f.workspace,
    { 'agent.txt': 'worker content\n' },
    'worker commit',
  );
  const files = {
    'agent.txt': 'worker content\n',
    ...(!equalTree && { 'report.md': '# Recovered report\n' }),
  };
  const hostHead = await commit(f.host, files, 'host recovered snapshot');
  if (importContainer) {
    await git(f.host, ['fetch', f.workspace, 'HEAD:refs/test-container-source']);
    await git(f.host, ['update-ref', '-d', 'refs/test-container-source']);
  }
  return { hostHead, containerHead, hostTree: await git(f.host, ['rev-parse', 'HEAD^{tree}']) };
}

async function cleanResources(f: Fixture, podId: string) {
  expect(await readdir(os.tmpdir())).toEqual([]);
  expect(await readdir(f.containerTmp)).toEqual([]);
  for (const [cwd, ref] of [
    [f.host, `refs/autopod-reconcile/${podId}`],
    [f.host, `refs/autopod-xfer/${podId}`],
    [f.workspace, `refs/autopod-xfer/${podId}`],
  ]) {
    await expect(git(cwd ?? '', ['rev-parse', '--verify', ref ?? ''])).rejects.toThrow();
  }
}

function prepare(f: Fixture, target: 'local' | 'sandbox', podId: string) {
  return f.preparation.prepareWorkspaceForValidation('container', f.host, f.cm, podId, target);
}

function resetCalls(f: Fixture) {
  return vi
    .mocked(f.cm.execInContainer)
    .mock.calls.filter(([, command]) => command.includes('reset'));
}

describe('validation workspace material boundary', () => {
  let root: string;
  beforeEach(async () => {
    root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'autopod-validation-workspace-')));
    const hostTmp = path.join(root, 'host-tmp');
    await mkdir(hostTmp);
    vi.stubEnv('TMPDIR', hostTmp);
    vi.stubEnv('GIT_CONFIG_GLOBAL', path.join(root, 'global.gitconfig'));
    vi.stubEnv('GIT_CONFIG_SYSTEM', '/dev/null');
    for (const kind of ['AUTHOR', 'COMMITTER']) {
      vi.stubEnv(`GIT_${kind}_NAME`, 'test');
      vi.stubEnv(`GIT_${kind}_EMAIL`, 'test@localhost');
    }
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  });

  it('leaves equal clean workspaces and indexes unchanged without transfer', async () => {
    const f = await fixture(root);
    const before = { host: await identity(f.host), container: await identity(f.workspace) };
    await prepare(f, 'local', 'equal');
    expect({ host: await identity(f.host), container: await identity(f.workspace) }).toEqual(
      before,
    );
    expect(f.sync).not.toHaveBeenCalled();
    expect(resetCalls(f)).toEqual([]);
    expect(f.cm.writeFile).not.toHaveBeenCalled();
  });

  it('resets a local container to the actual host-ahead commit before cleaning it', async () => {
    const f = await fixture(root);
    const target = await commit(f.host, { 'host.txt': 'human fix\n' }, 'human fix');
    await git(f.workspace, ['fetch', f.host, 'HEAD:refs/test-host-source']);
    await writeFile(path.join(f.workspace, 'discard-me.txt'), 'untracked container file');
    const before = await identity(f.host);

    await prepare(f, 'local', 'host-ahead');

    expect(await git(f.workspace, ['rev-parse', 'HEAD'])).toBe(target);
    expect(await readFile(path.join(f.workspace, 'host.txt'), 'utf8')).toBe('human fix\n');
    await expect(lstat(path.join(f.workspace, 'discard-me.txt'))).rejects.toThrow();
    expect(await identity(f.host)).toEqual(before);
    expect(f.sync).not.toHaveBeenCalled();
    const commands = vi.mocked(f.cm.execInContainer).mock.calls.map(([, command]) => command);
    expect(commands.findIndex((command) => command.includes('reset'))).toBeLessThan(
      commands.findIndex((command) => command.includes('clean')),
    );
  });

  it('composes real sync-back for a local container-ahead commit and dirty file', async () => {
    const f = await fixture(root);
    await writeFile(path.join(f.workspace, '.git/objects/info/alternates'), `${f.bare}/objects\n`);
    const target = await commit(f.workspace, { 'agent.txt': 'worker commit\n' }, 'worker commit');
    await writeFile(path.join(f.workspace, 'root.txt'), 'dirty edit\n');
    await writeFile(path.join(f.workspace, "worker's report.md"), 'untracked report\n');
    const before = await identity(f.workspace);
    const gitlink = await readFile(path.join(f.host, '.git'), 'utf8');
    const transfer = createWorkspaceTransfer({ logger, captureAuthority: () => () => {} });
    const preparation = createValidationWorkspace({
      logger,
      syncWorkspaceBack: transfer.syncWorkspaceBack,
    });

    await preparation.prepareWorkspaceForValidation(
      'container',
      f.host,
      f.cm,
      'container-ahead',
      'local',
    );

    expect(await git(f.host, ['rev-parse', 'HEAD'])).toBe(target);
    expect(await readFile(path.join(f.host, 'agent.txt'), 'utf8')).toBe('worker commit\n');
    expect(await readFile(path.join(f.host, 'root.txt'), 'utf8')).toBe('dirty edit\n');
    expect(await readFile(path.join(f.host, "worker's report.md"), 'utf8')).toBe(
      'untracked report\n',
    );
    expect(await readFile(path.join(f.host, '.git'), 'utf8')).toBe(gitlink);
    expect(await identity(f.workspace)).toEqual(before);
  });

  it('refuses actual local divergence without mutating refs, indexes or source files', async () => {
    const f = await fixture(root);
    await diverge(f);
    await git(f.workspace, ['fetch', f.host, 'HEAD:refs/test-host-source']);
    const before = { host: await identity(f.host), container: await identity(f.workspace) };

    await expect(prepare(f, 'local', 'local-divergence')).rejects.toBeInstanceOf(
      ValidationWorkspaceReconcileError,
    );

    expect({ host: await identity(f.host), container: await identity(f.workspace) }).toEqual(
      before,
    );
    expect(f.sync).not.toHaveBeenCalled();
    expect(resetCalls(f)).toEqual([]);
    expect(f.cm.writeFile).not.toHaveBeenCalled();
  });

  it('grafts the real host tree and transfers its commit into an isolated sandbox before reset', async () => {
    const f = await fixture(root);
    const { hostHead, containerHead, hostTree } = await diverge(f);
    await expect(git(f.workspace, ['cat-file', '-e', `${hostHead}^{commit}`])).rejects.toThrow();

    await prepare(f, 'sandbox', 'sandbox-divergence');

    const target = await git(f.host, ['rev-parse', 'HEAD']);
    expect(target).not.toBe(hostHead);
    expect(target).not.toBe(containerHead);
    expect(await git(f.host, ['rev-parse', 'HEAD^'])).toBe(containerHead);
    expect(await git(f.host, ['rev-parse', 'HEAD^{tree}'])).toBe(hostTree);
    expect(await git(f.workspace, ['rev-parse', 'HEAD'])).toBe(target);
    expect(await git(f.workspace, ['rev-parse', 'HEAD^{tree}'])).toBe(hostTree);
    expect(await readFile(path.join(f.workspace, 'agent.txt'), 'utf8')).toBe('worker content\n');
    expect(await readFile(path.join(f.workspace, 'report.md'), 'utf8')).toBe(
      '# Recovered report\n',
    );
    expect(f.uploads).toHaveLength(1);
    expect(f.uploads[0]?.toString('utf8', 0, 20)).toMatch(/^# v[23] git bundle\n/);
    const commands = vi.mocked(f.cm.execInContainer).mock.calls.map(([, command]) => command);
    expect(commands.findIndex((command) => command.includes('fetch'))).toBeLessThan(
      commands.findIndex((command) => command.includes('reset')),
    );
    expect(f.sync).not.toHaveBeenCalled();
    await cleanResources(f, 'sandbox-divergence');
  });

  it('transfers a host-only sandbox commit without creating another host commit', async () => {
    const f = await fixture(root);
    const target = await commit(f.host, { 'human.txt': 'human fix\n' }, 'human fix');
    const before = await identity(f.host);
    await expect(git(f.workspace, ['cat-file', '-e', `${target}^{commit}`])).rejects.toThrow();

    await prepare(f, 'sandbox', 'sandbox-host-ahead');

    expect(await identity(f.host)).toEqual(before);
    expect(await git(f.workspace, ['rev-parse', 'HEAD'])).toBe(target);
    expect(await readFile(path.join(f.workspace, 'human.txt'), 'utf8')).toBe('human fix\n');
    expect(f.uploads).toHaveLength(1);
    await cleanResources(f, 'sandbox-host-ahead');
  });

  it('uses the existing equal-tree target without an empty commit, bundle or reset', async () => {
    const f = await fixture(root);
    const { containerHead, hostTree } = await diverge(f, true, true);
    const count = await git(f.host, ['rev-list', '--count', 'HEAD']);

    await prepare(f, 'sandbox', 'equal-tree');

    expect(await git(f.host, ['rev-parse', 'HEAD'])).toBe(containerHead);
    expect(await git(f.host, ['rev-parse', 'HEAD^{tree}'])).toBe(hostTree);
    expect(await git(f.host, ['rev-list', '--count', 'HEAD'])).toBe(count);
    expect(await git(f.workspace, ['rev-parse', 'HEAD'])).toBe(containerHead);
    expect(f.uploads).toEqual([]);
    expect(resetCalls(f)).toEqual([]);
    await cleanResources(f, 'equal-tree');
  });

  it.each(['upload', 'fetch'] as const)(
    'does not reset to an unavailable target after %s failure, and retains the completed graft',
    async (failure) => {
      const f = await fixture(root);
      const { hostHead, containerHead, hostTree } = await diverge(f);
      if (failure === 'upload')
        vi.mocked(f.cm.writeFile).mockRejectedValue(new Error('upload failed'));
      else {
        const execute = vi.mocked(f.cm.execInContainer).getMockImplementation();
        vi.mocked(f.cm.execInContainer).mockImplementation(async (id, command, options) => {
          if (command.includes('fetch')) return { stdout: '', stderr: 'fetch failed', exitCode: 1 };
          if (!execute) throw new Error('missing container execution');
          return execute(id, command, options);
        });
      }

      await expect(prepare(f, 'sandbox', `failed-${failure}`)).rejects.toBeInstanceOf(
        ValidationWorkspaceReconcileError,
      );

      const graft = await git(f.host, ['rev-parse', 'HEAD']);
      expect(graft).not.toBe(hostHead);
      expect(await git(f.host, ['rev-parse', 'HEAD^'])).toBe(containerHead);
      expect(await git(f.host, ['rev-parse', 'HEAD^{tree}'])).toBe(hostTree);
      expect(await git(f.workspace, ['rev-parse', 'HEAD'])).toBe(containerHead);
      await expect(git(f.workspace, ['cat-file', '-e', `${graft}^{commit}`])).rejects.toThrow();
      expect(resetCalls(f)).toEqual([]);
      await cleanResources(f, `failed-${failure}`);
    },
  );

  it('refuses a missing container object from mismatched alternates without moving unrelated refs', async () => {
    const f = await fixture(root);
    const { containerHead } = await diverge(f, false);
    const unrelated = path.join(root, 'unrelated.git');
    await git(root, ['clone', '--bare', f.seed, unrelated]);
    await writeFile(
      path.join(f.workspace, '.git/objects/info/alternates'),
      `${unrelated}/objects\n`,
    );
    const before = {
      host: await identity(f.host),
      container: await identity(f.workspace),
      unrelated: await git(root, ['--git-dir', unrelated, 'show-ref']),
    };
    await expect(git(f.host, ['cat-file', '-e', `${containerHead}^{commit}`])).rejects.toThrow();

    await expect(prepare(f, 'sandbox', 'mismatch')).rejects.toBeInstanceOf(
      ValidationWorkspaceReconcileError,
    );

    expect({
      host: await identity(f.host),
      container: await identity(f.workspace),
      unrelated: await git(root, ['--git-dir', unrelated, 'show-ref']),
    }).toEqual(before);
    expect(
      vi.mocked(f.cm.execInContainer).mock.calls.some(([, command]) => command.includes('push')),
    ).toBe(false);
    expect(f.uploads).toEqual([]);
    expect(resetCalls(f)).toEqual([]);
    await cleanResources(f, 'mismatch');
  });
});
