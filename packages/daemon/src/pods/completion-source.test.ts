import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { Pod } from '@autopod/shared';
import Database from 'better-sqlite3';
import { afterAll, describe, expect, it, vi } from 'vitest';
import {
  createMockContainerManager,
  createMockProfileStore,
  createTestDb,
  insertTestProfile,
  logger,
} from '../test-utils/mock-helpers.js';
import { DeletionGuardError, LocalWorktreeManager } from '../worktrees/local-worktree-manager.js';
import { createCompletionSource } from './completion-source.js';
import { createPodRepository } from './pod-repository.js';

// These values are captured by production Git wrappers at module initialization.
const priorGitEnvironment = vi.hoisted(() => {
  const values = {
    GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL,
    GIT_CONFIG_SYSTEM: process.env.GIT_CONFIG_SYSTEM,
    GIT_CONFIG_NOSYSTEM: process.env.GIT_CONFIG_NOSYSTEM,
    GIT_CONFIG_COUNT: process.env.GIT_CONFIG_COUNT,
  };
  process.env.GIT_CONFIG_GLOBAL = '/dev/null';
  process.env.GIT_CONFIG_SYSTEM = '/dev/null';
  process.env.GIT_CONFIG_NOSYSTEM = '1';
  Reflect.deleteProperty(process.env, 'GIT_CONFIG_COUNT');
  return values;
});
vi.mock('../providers/llm-client.js', () => ({
  createProfileAnthropicClient: vi.fn(async () => ({ ok: false, reason: 'no_credentials' })),
}));
afterAll(() => {
  for (const [key, value] of Object.entries(priorGitEnvironment)) {
    if (value === undefined) Reflect.deleteProperty(process.env, key);
    else process.env[key] = value;
  }
});

const run = promisify(execFile);
async function git(cwd: string, args: string[]) {
  return (await run('git', args, { cwd, timeout: 10_000 })).stdout.trim();
}

async function fixture(executionTarget: Pod['executionTarget'] = 'local') {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'completion-source-')));
  const source = path.join(root, 'source');
  await mkdir(source);
  await git(source, ['init', '--initial-branch=main']);
  for (const [key, value] of Object.entries({
    'user.name': 'Source fixture',
    'user.email': 'source@example.invalid',
    'commit.gpgSign': 'false',
    'core.hooksPath': '/dev/null',
    'core.fileMode': 'true',
  })) {
    await git(source, ['config', key, value]);
  }
  await writeFile(path.join(source, 'base.txt'), 'original\n');
  await writeFile(path.join(source, 'pnpm-lock.yaml'), 'initial lock\n');
  await git(source, ['add', '.']);
  await git(source, ['commit', '-m', 'base']);
  const base = await git(source, ['rev-parse', 'HEAD']);
  const databaseFile = path.join(root, 'state.db');
  const seed = createTestDb();
  try {
    insertTestProfile(seed);
    await writeFile(databaseFile, seed.serialize());
  } finally {
    seed.close();
  }
  let db = new Database(databaseFile);
  db.pragma('foreign_keys = ON');
  const repo = createPodRepository(db);
  repo.insert({
    id: 'worker',
    profileName: 'test-profile',
    task: 'Prepare source',
    status: 'running',
    model: 'model',
    runtime: 'codex',
    executionTarget,
    branch: 'main',
    userId: 'operator',
    maxValidationAttempts: 3,
    skipValidation: false,
    outputMode: 'pr',
  });
  repo.update('worker', {
    worktreePath: source,
    containerId: 'source-container',
    startCommitSha: base,
    filesChanged: 9,
    linesAdded: 19,
    linesRemoved: 4,
  });
  const profile = createMockProfileStore(db).get('test-profile');
  const worktrees = new LocalWorktreeManager({
    cacheDir: path.join(root, 'cache'),
    worktreeDir: path.join(root, 'worktrees'),
    logger,
  });
  const worktreeManager = {
    classifyCanonicalDiff: vi.fn(worktrees.classifyCanonicalDiff.bind(worktrees)),
    commitPendingChangesWithGeneratedMessage: vi.fn(
      worktrees.commitPendingChangesWithGeneratedMessage.bind(worktrees),
    ),
    getDiffStats: vi.fn(worktrees.getDiffStats.bind(worktrees)),
  };
  const cm = createMockContainerManager();
  const dependencies = {
    podRepo: repo,
    getContainerManager: vi.fn(() => cm),
    worktreeManager,
    checkpointSandboxWorkspaceForPod: vi.fn(async (_pod: Pod) => {
      const head = await git(source, ['rev-parse', 'HEAD']);
      const tree = await git(source, ['rev-parse', 'HEAD^{tree}']);
      return {
        sequence: 1,
        sourceHead: head,
        sourceTree: tree,
        snapshotCommit: head,
        snapshotTree: tree,
        transferVerified: true,
        bundleVerified: true,
        hostImported: true,
        lineageVerified: true,
        promoted: true,
        materialized: true,
        quarantineRef: 'refs/fixture/checkpoint',
      };
    }),
    syncSandboxSeriesHandover: vi.fn(async (_podId: string) => {}),
    syncWorkspaceBack: vi.fn(async () => ({ pushed: true })),
    tryRecoverAfterWorkspaceSyncFailure: vi.fn(async () => false),
    recoverWorktreeFromContainer: vi.fn(async () => false),
    parkOnWorktreeSyncFailure: vi.fn((id: string, _reason: string) => {
      repo.update(id, { worktreeCompromised: true, status: 'failed' });
    }),
    handleDeletionGuardError: vi.fn((id: string, error: unknown) => {
      if (!(error instanceof DeletionGuardError)) return false;
      repo.update(id, { worktreeCompromised: true });
      return true;
    }),
    transition: vi.fn((pod: Pod, to: 'failed') => {
      repo.update(pod.id, { status: to });
      return repo.getOrThrow(pod.id);
    }),
    executionForPod: vi.fn(() => profile),
    emitActivityStatus: vi.fn(),
    logger,
  };
  const prepare = () =>
    createCompletionSource(dependencies).prepareSourceForCompletion(repo.getOrThrow('worker'));
  return {
    root,
    source,
    base,
    repo,
    cm,
    dependencies,
    worktreeManager,
    prepare,
    async snapshot() {
      return {
        head: await git(source, ['rev-parse', 'HEAD']),
        tree: await git(source, ['rev-parse', 'HEAD^{tree}']),
        status: await git(source, ['status', '--porcelain']),
      };
    },
    reopen() {
      db.close();
      db = new Database(databaseFile);
      db.pragma('foreign_keys = ON');
      expect(db.pragma('integrity_check', { simple: true })).toBe('ok');
      expect(db.pragma('foreign_key_check')).toEqual([]);
      return createPodRepository(db);
    },
    async close() {
      db.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

describe('completion source material boundary', () => {
  it('runs real staging, heuristic auto-commit and base-scoped diff, persisting stats across reopen', async () => {
    const f = await fixture();
    try {
      await writeFile(path.join(f.source, 'feature.txt'), 'feature one\nfeature two\n');
      const prepared = await f.prepare();
      expect(prepared).toEqual({
        sandboxCheckpoint: undefined,
        sandboxCanonicalOutcome: undefined,
        sandboxHostProof: undefined,
      });
      const final = await f.snapshot();
      expect(final.head).not.toBe(f.base);
      expect(final.status).toBe('');
      expect(await git(f.source, ['rev-parse', 'HEAD^'])).toBe(f.base);
      expect(await git(f.source, ['show', 'HEAD:feature.txt'])).toBe('feature one\nfeature two');
      expect(await git(f.source, ['log', '-1', '--format=%s'])).not.toBe('');
      expect(f.worktreeManager.getDiffStats).toHaveBeenCalledWith(f.source, 'main', f.base);
      expect(f.reopen().getOrThrow('worker')).toMatchObject({
        status: 'running',
        filesChanged: 1,
        linesAdded: 2,
        linesRemoved: 0,
      });
    } finally {
      await f.close();
    }
  });

  it.each([0, 100])(
    'enforces real deletion threshold %s without inventing workspace rollback',
    async (threshold) => {
      const f = await fixture();
      try {
        const names =
          threshold === 0 ? ['base.txt'] : Array.from({ length: 101 }, (_, i) => `remove-${i}.txt`);
        if (threshold === 100) {
          await Promise.all(
            names.map((name) => writeFile(path.join(f.source, name), 'retained\n')),
          );
          await git(f.source, ['add', '.']);
          await git(f.source, ['commit', '-m', 'tracked files']);
          f.repo.update('worker', { containerId: null });
        } else {
          f.dependencies.syncWorkspaceBack.mockResolvedValueOnce({ pushed: false });
        }
        const before = await f.snapshot();
        await Promise.all(names.map((name) => rm(path.join(f.source, name))));
        expect(await f.prepare()).toBeUndefined();
        const after = await f.snapshot();
        expect(after.head).toBe(before.head);
        expect(after.tree).toBe(before.tree);
        expect(await git(f.source, ['diff', '--cached', '--name-only'])).toBe('');
        expect((await git(f.source, ['diff', '--name-only'])).split('\n').sort()).toEqual(
          names.sort(),
        );
        expect(
          f.worktreeManager.commitPendingChangesWithGeneratedMessage.mock.calls[0]?.[4],
        ).toEqual({ maxDeletions: threshold });
        expect(f.dependencies.handleDeletionGuardError).toHaveBeenCalledWith(
          'worker',
          expect.any(DeletionGuardError),
        );
        expect(f.worktreeManager.getDiffStats).not.toHaveBeenCalled();
        expect(f.reopen().getOrThrow('worker')).toMatchObject({
          status: 'failed',
          worktreeCompromised: true,
          filesChanged: 9,
        });
      } finally {
        await f.close();
      }
    },
  );

  it('retries a real guarded commit with 100 after controlled recovery restores actual source files', async () => {
    const f = await fixture();
    try {
      await rm(path.join(f.source, 'base.txt'));
      await writeFile(path.join(f.source, 'feature.txt'), 'new feature\n');
      f.dependencies.syncWorkspaceBack.mockResolvedValueOnce({ pushed: false });
      f.dependencies.recoverWorktreeFromContainer.mockImplementationOnce(async () => {
        await writeFile(path.join(f.source, 'base.txt'), 'original\n');
        return true;
      });
      expect(await f.prepare()).toBeDefined();
      expect(
        f.worktreeManager.commitPendingChangesWithGeneratedMessage.mock.calls.map(
          (call) => call[4]?.maxDeletions,
        ),
      ).toEqual([0, 100]);
      expect(await git(f.source, ['show', 'HEAD:base.txt'])).toBe('original');
      expect(await git(f.source, ['show', 'HEAD:feature.txt'])).toBe('new feature');
      expect((await f.snapshot()).status).toBe('');
      expect(f.reopen().getOrThrow('worker')).toMatchObject({
        status: 'running',
        filesChanged: 1,
        linesAdded: 1,
        linesRemoved: 0,
      });
    } finally {
      await f.close();
    }
  });

  it.each(['changed', 'unchanged', 'net-zero', 'excluded-only', 'mode-only'] as const)(
    'classifies real sandbox Git state %s and returns matching checkpoint/host proof',
    async (mode) => {
      const f = await fixture('sandbox');
      try {
        if (mode === 'changed' || mode === 'net-zero') {
          await writeFile(path.join(f.source, 'base.txt'), 'changed\n');
          await git(f.source, ['commit', '-am', 'change']);
          if (mode === 'net-zero') {
            await writeFile(path.join(f.source, 'base.txt'), 'original\n');
            await git(f.source, ['commit', '-am', 'restore tree']);
          }
        } else if (mode === 'excluded-only') {
          await writeFile(path.join(f.source, 'pnpm-lock.yaml'), 'new lock\n');
          await git(f.source, ['commit', '-am', 'lock only']);
        } else if (mode === 'mode-only') {
          await chmod(path.join(f.source, 'base.txt'), 0o755);
          await git(f.source, ['commit', '-am', 'mode only']);
        }
        const before = await f.snapshot();
        const prepared = await f.prepare();
        expect(prepared).toMatchObject({
          sandboxCanonicalOutcome: mode === 'changed' ? 'changed' : 'unchanged',
          sandboxCheckpoint: { snapshotCommit: before.head, snapshotTree: before.tree },
          sandboxHostProof: { head: before.head, tree: before.tree },
        });
        expect(f.worktreeManager.classifyCanonicalDiff).toHaveBeenCalledWith(
          f.source,
          f.base,
          before.head,
          before.tree,
        );
        expect(f.worktreeManager.commitPendingChangesWithGeneratedMessage).not.toHaveBeenCalled();
        expect(f.dependencies.syncWorkspaceBack).not.toHaveBeenCalled();
        expect(await f.snapshot()).toEqual(before);
        expect(f.reopen().getOrThrow('worker')).toMatchObject({
          status: 'running',
          filesChanged: mode === 'changed' ? 1 : 0,
          linesAdded: mode === 'changed' ? 1 : 0,
          linesRemoved: mode === 'changed' ? 1 : 0,
        });
      } finally {
        await f.close();
      }
    },
  );

  it.each(['missing-base', 'head-mismatch', 'tree-mismatch'] as const)(
    'blocks actual sandbox proof failure %s without rewriting source or stored stats',
    async (mode) => {
      const f = await fixture('sandbox');
      try {
        if (mode === 'missing-base') f.repo.update('worker', { startCommitSha: 'f'.repeat(40) });
        else {
          const proof = await f.dependencies.checkpointSandboxWorkspaceForPod(
            f.repo.getOrThrow('worker'),
          );
          f.dependencies.checkpointSandboxWorkspaceForPod.mockResolvedValueOnce({
            ...proof,
            ...(mode === 'head-mismatch'
              ? { snapshotCommit: 'f'.repeat(40) }
              : { snapshotTree: 'f'.repeat(40) }),
          });
        }
        const before = await f.snapshot();
        expect(await f.prepare()).toBeUndefined();
        expect(await f.snapshot()).toEqual(before);
        expect(f.dependencies.parkOnWorktreeSyncFailure).toHaveBeenCalledWith(
          'worker',
          expect.stringContaining(
            mode === 'missing-base' ? 'BASE_UNAVAILABLE' : 'HOST_PROOF_MISMATCH',
          ),
        );
        expect(f.reopen().getOrThrow('worker')).toMatchObject({
          status: 'failed',
          worktreeCompromised: true,
          filesChanged: 9,
          linesAdded: 19,
          linesRemoved: 4,
        });
      } finally {
        await f.close();
      }
    },
  );

  it.each(['handover', 'checkpoint', 'classifier', 'recovery'] as const)(
    'propagates controlled %s rejection without a source-success object',
    async (mode) => {
      const f = await fixture(mode === 'checkpoint' || mode === 'classifier' ? 'sandbox' : 'local');
      try {
        if (mode === 'handover')
          f.dependencies.syncSandboxSeriesHandover.mockRejectedValueOnce(
            new Error('boundary fault'),
          );
        else if (mode === 'recovery') {
          f.dependencies.syncWorkspaceBack.mockRejectedValueOnce(new Error('sync fault'));
          f.dependencies.tryRecoverAfterWorkspaceSyncFailure.mockRejectedValueOnce(
            new Error('boundary fault'),
          );
        } else {
          if (mode === 'checkpoint')
            f.dependencies.checkpointSandboxWorkspaceForPod.mockRejectedValueOnce(
              new Error('boundary fault'),
            );
          else
            f.worktreeManager.classifyCanonicalDiff.mockRejectedValueOnce(
              new Error('boundary fault'),
            );
        }
        await expect(f.prepare()).rejects.toThrow('boundary fault');
        expect(f.worktreeManager.commitPendingChangesWithGeneratedMessage).not.toHaveBeenCalled();
        expect(f.reopen().getOrThrow('worker')).toMatchObject({
          status: 'running',
          filesChanged: 9,
        });
      } finally {
        await f.close();
      }
    },
  );

  it.each([
    'commit-error',
    'commit-non-error',
    'stats-error',
    'empty-local',
    'failed-sync',
  ] as const)('retains continuation/stopping semantics for %s', async (mode) => {
    const f = await fixture();
    try {
      if (mode === 'commit-error' || mode === 'commit-non-error')
        f.worktreeManager.commitPendingChangesWithGeneratedMessage.mockRejectedValueOnce(
          mode === 'commit-error' ? new Error('commit fault') : 'commit fault',
        );
      if (mode === 'stats-error')
        f.worktreeManager.getDiffStats.mockRejectedValueOnce(new Error('stats fault'));
      if (mode === 'empty-local') f.repo.update('worker', { worktreePath: null });
      if (mode === 'failed-sync')
        f.dependencies.syncWorkspaceBack.mockRejectedValueOnce(new Error('sync fault'));
      const result = await f.prepare();
      if (mode === 'failed-sync') {
        expect(result).toBeUndefined();
        expect(f.worktreeManager.commitPendingChangesWithGeneratedMessage).not.toHaveBeenCalled();
        expect(f.dependencies.parkOnWorktreeSyncFailure).toHaveBeenCalledOnce();
      } else {
        expect(result).toEqual({
          sandboxCheckpoint: undefined,
          sandboxCanonicalOutcome: undefined,
          sandboxHostProof: undefined,
        });
        if (mode === 'empty-local') {
          expect(f.worktreeManager.commitPendingChangesWithGeneratedMessage).not.toHaveBeenCalled();
          expect(f.worktreeManager.getDiffStats).not.toHaveBeenCalled();
        }
        expect(f.reopen().getOrThrow('worker')).toMatchObject({
          status: 'running',
          filesChanged: mode === 'stats-error' || mode === 'empty-local' ? 9 : 0,
        });
      }
    } finally {
      await f.close();
    }
  });
});
