import { execFile } from 'node:child_process';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockContainerManager } from '../test-utils/mock-helpers.js';
import { autopodStagingRef, deriveBareRepoPath } from '../worktrees/bare-push.js';
import { LocalWorktreeManager } from '../worktrees/local-worktree-manager.js';
import type { FixHistoryRewritePolicy } from './fix-history-rewrite-policy.js';
import {
  createValidationWorkspace,
  ValidationWorkspaceReconcileError,
} from './validation-workspace.js';
import { createWorkspaceTransfer } from './workspace-transfer.js';

/**
 * #663: a PR fix pod on local Docker whose agent rebased the PR branch onto a
 * moved base (resolving a conflict) must reach validation and be delivered to
 * the existing PR with a lease — using real Git for the remote, the daemon's
 * bare cache, the linked host worktree and an alternates-backed container
 * checkout. No Docker, daemon or network is involved.
 */

const run = promisify(execFile);
const logger = pino({ level: 'silent' });
const POD = 'fixpod663';

type RemoteOverride = {
  getAuthenticatedRemote(worktreePath: string): Promise<{ url: string }>;
  getAuthenticatedRemoteForRepo(repoUrl: string): Promise<{ url: string }>;
};

async function git(cwd: string, args: string[]) {
  return (await run('git', args, { cwd, timeout: 10_000 })).stdout.trim();
}

let clock = 1_800_000_000;
async function commit(cwd: string, files: Record<string, string>, message: string) {
  for (const [name, bytes] of Object.entries(files)) await writeFile(path.join(cwd, name), bytes);
  await git(cwd, ['add', '-A']);
  clock += 60;
  await run('git', ['commit', '-q', '-m', message], {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_DATE: `${clock} +0000`,
      GIT_COMMITTER_DATE: `${clock} +0000`,
    },
  });
  return git(cwd, ['rev-parse', 'HEAD']);
}

const policy: FixHistoryRewritePolicy = {
  kind: 'canonical-pr-fix',
  podId: POD,
  parentPodId: 'parent663',
  prUrl: 'https://github.com/org/repo/pull/133',
  branch: 'feature',
  baseBranch: 'main',
};

async function fixture(root: string) {
  const remote = path.join(root, 'remote.git');
  const seed = path.join(root, 'seed');
  await git(root, ['init', '-q', '--bare', '--initial-branch=main', remote]);
  await git(root, ['clone', '-q', remote, seed]);
  await commit(seed, { 'shared.txt': 'base\n', 'keep.txt': 'keep\n' }, 'base');
  await git(seed, ['push', '-q', 'origin', 'HEAD:refs/heads/main']);
  // The published PR branch (old head P).
  await git(seed, ['checkout', '-q', '-b', 'feature']);
  await commit(seed, { 'shared.txt': 'feature\n' }, 'feature edits shared');
  const prHead = await commit(seed, { 'feature.txt': 'feature\n' }, 'feature adds file');
  await git(seed, ['push', '-q', 'origin', 'feature']);
  // The base moves with a conflicting edit and a deletion.
  await git(seed, ['checkout', '-q', 'main']);
  await git(seed, ['rm', '-q', 'keep.txt']);
  await commit(seed, { 'shared.txt': 'main\n' }, 'main edits shared');
  const baseTip = await commit(seed, { 'main.txt': 'main\n' }, 'main adds file');
  await git(seed, ['push', '-q', 'origin', 'main']);

  // Fix pod provisioning: daemon bare cache + linked host worktree on the PR head.
  const manager = new LocalWorktreeManager({
    cacheDir: path.join(root, 'cache'),
    worktreeDir: path.join(root, 'worktrees'),
    logger,
  });
  const override = manager as unknown as RemoteOverride;
  override.getAuthenticatedRemote = async () => ({ url: remote });
  override.getAuthenticatedRemoteForRepo = async () => ({ url: remote });
  const { worktreePath: host } = await manager.create({
    repoUrl: 'https://github.com/org/repo.git',
    branch: 'feature',
    baseBranch: 'main',
    sessionId: POD,
  });
  expect(await git(host, ['rev-parse', 'HEAD'])).toBe(prHead);
  const bare = await deriveBareRepoPath(host);
  expect(await git(host, ['rev-parse', 'refs/remotes/origin/main'])).toBe(baseTip);

  // Container checkout: real .git whose alternates point at the bare objects.
  const workspace = path.join(root, 'container');
  await git(root, ['clone', '-q', '--shared', '--no-checkout', bare, workspace]);
  expect(
    (await readFile(path.join(workspace, '.git/objects/info/alternates'), 'utf8')).trim(),
  ).toBe(path.join(bare, 'objects'));
  await git(workspace, ['checkout', '-q', '-B', 'feature', prHead]);
  await git(workspace, ['update-ref', 'refs/remotes/origin/main', baseTip]);

  const cm = createMockContainerManager();
  cm.execInContainer = vi.fn(async (_id, command) => {
    const mapped = command.map((part) =>
      part.replaceAll('/mnt/worktree', host).replaceAll('/workspace', workspace),
    );
    const executable = mapped[0];
    if (!executable) throw new Error('Empty container command');
    try {
      const result = await run(executable, mapped.slice(1), { timeout: 10_000 });
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
  return { remote, seed, manager, host, bare, workspace, cm, prHead, baseTip };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

/** The agent's work: `git rebase origin/main`, resolve the conflict, continue. */
async function agentRebases(f: Fixture) {
  try {
    await git(f.workspace, ['rebase', 'origin/main']);
  } catch {
    await writeFile(path.join(f.workspace, 'shared.txt'), 'main + feature\n');
    await git(f.workspace, ['add', 'shared.txt']);
    await run('git', ['rebase', '--continue'], {
      cwd: f.workspace,
      env: { ...process.env, GIT_EDITOR: 'true' },
    });
  }
  return git(f.workspace, ['rev-parse', 'HEAD']);
}

function transferFor(withPolicy: boolean) {
  const adopted = vi.fn();
  const transfer = createWorkspaceTransfer({
    logger,
    captureAuthority: () => () => {},
    historyRewritePolicy: () => (withPolicy ? policy : null),
    onHistoryRewriteAdopted: adopted,
  });
  const preparation = createValidationWorkspace({
    logger,
    syncWorkspaceBack: transfer.syncWorkspaceBack,
    adoptContainerHistoryRewrite: transfer.adoptContainerHistoryRewrite,
  });
  return { transfer, preparation, adopted };
}

async function hostState(f: Fixture) {
  return {
    head: await git(f.host, ['rev-parse', 'HEAD']),
    status: await git(f.host, ['status', '--porcelain']),
    shared: await readFile(path.join(f.host, 'shared.txt'), 'utf8'),
  };
}

describe('#663 rebase fix pod delivery on local Docker', () => {
  let root: string;
  beforeEach(async () => {
    root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'autopod-663-')));
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

  it('adopts the proven rebase at sync-back, validates, and delivers it with a lease on the old PR head', async () => {
    const f = await fixture(root);
    const rebased = await agentRebases(f);
    const { transfer, preparation, adopted } = transferFor(true);

    // Completion sync-back: the rewrite is adopted instead of refused.
    await expect(
      transfer.syncWorkspaceBack('container', f.host, f.cm, POD, 'local'),
    ).resolves.toEqual({ pushed: true });
    expect(await hostState(f)).toEqual({ head: rebased, status: '', shared: 'main + feature\n' });
    expect(adopted).toHaveBeenCalledOnce();
    expect(adopted).toHaveBeenCalledWith(POD, {
      policy,
      evidence: {
        predecessor: f.prHead,
        candidate: rebased,
        baseRef: 'refs/remotes/origin/main',
        baseTip: f.baseTip,
        predecessorFork: await git(f.host, ['rev-parse', `${f.baseTip}~2`]),
        candidateFork: f.baseTip,
        patchEquivalent: 1,
        fingerprintMatched: 1,
      },
    });
    await expect(
      git(f.host, ['--git-dir', f.bare, 'rev-parse', '--verify', autopodStagingRef(POD)]),
    ).rejects.toThrow();

    // Validation preparation: host and container agree, nothing to reconcile.
    await preparation.prepareWorkspaceForValidation('container', f.host, f.cm, POD, 'local');
    expect(await git(f.workspace, ['rev-parse', 'HEAD'])).toBe(rebased);

    // Fix delivery: base already contained → no daemon rewrite; leased force push.
    await expect(
      f.manager.rebaseOntoBase({ worktreePath: f.host, baseBranch: 'main' }),
    ).resolves.toMatchObject({ rebased: true, alreadyUpToDate: true });
    const receipt = await f.manager.pushBranch(f.host, 'feature', {
      force: true,
      expectedRemoteCommitSha: f.prHead,
    });
    expect(receipt.commitSha).toBe(rebased);
    expect(await git(f.remote, ['rev-parse', 'refs/heads/feature'])).toBe(rebased);
  });

  it('adopts the proven rebase during validation preparation when sync-back has not run', async () => {
    const f = await fixture(root);
    const rebased = await agentRebases(f);
    const { preparation, adopted } = transferFor(true);

    await preparation.prepareWorkspaceForValidation('container', f.host, f.cm, POD, 'local');

    expect(await hostState(f)).toEqual({ head: rebased, status: '', shared: 'main + feature\n' });
    expect(adopted).toHaveBeenCalledOnce();
  });

  it('refuses delivery when the PR branch moved after the recorded head', async () => {
    const f = await fixture(root);
    const rebased = await agentRebases(f);
    const { transfer } = transferFor(true);
    await transfer.syncWorkspaceBack('container', f.host, f.cm, POD, 'local');
    await git(f.seed, ['checkout', '-q', 'feature']);
    const concurrent = await commit(f.seed, { 'human.txt': 'human\n' }, 'human push');
    await git(f.seed, ['push', '-q', 'origin', 'feature']);

    await expect(
      f.manager.pushBranch(f.host, 'feature', { force: true, expectedRemoteCommitSha: f.prHead }),
    ).rejects.toMatchObject({ code: 'SOURCE_PUBLICATION_RECONCILIATION_REQUIRED' });
    expect(await git(f.remote, ['rev-parse', 'refs/heads/feature'])).toBe(concurrent);
    expect(await git(f.host, ['rev-parse', 'HEAD'])).toBe(rebased);
  });

  it.each([
    ['an unproven divergence (dropped PR commit)', true],
    ['a proven rebase without fix-pod authority', false],
  ] as const)('keeps the strict throw for %s without touching the host', async (_label, withPolicy) => {
    const f = await fixture(root);
    await agentRebases(f);
    if (withPolicy) {
      // Drop the conflict-resolved commit: no longer accounts for the PR head.
      await git(f.workspace, ['reset', '-q', '--hard', 'origin/main']);
      await commit(f.workspace, { 'feature.txt': 'feature\n' }, 'feature adds file');
    }
    const { preparation, adopted } = transferFor(withPolicy);
    const before = await hostState(f);

    await expect(
      preparation.prepareWorkspaceForValidation('container', f.host, f.cm, POD, 'local'),
    ).rejects.toBeInstanceOf(ValidationWorkspaceReconcileError);

    expect(await hostState(f)).toEqual(before);
    expect(before.head).toBe(f.prHead);
    expect(adopted).not.toHaveBeenCalled();
    await expect(
      git(f.host, ['--git-dir', f.bare, 'rev-parse', '--verify', autopodStagingRef(POD)]),
    ).rejects.toThrow();
  });
});
