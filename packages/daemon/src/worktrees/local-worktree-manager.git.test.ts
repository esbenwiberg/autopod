import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import Database from 'better-sqlite3';
import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { WorktreeManager } from '../interfaces/worktree-manager.js';
import { createPodRepository } from '../pods/pod-repository.js';
import { createSourcePublicationLedger } from '../pods/source-publication-ledger.js';
import {
  createMockWorktreeManager,
  createTestDb,
  insertTestProfile,
} from '../test-utils/mock-helpers.js';
import { publishCommittedSource, publishSource } from './durable-source-publication.js';
import { LocalWorktreeManager } from './local-worktree-manager.js';

const execFileAsync = promisify(execFile);
const logger = pino({ level: 'silent' });
const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: 'test',
  GIT_AUTHOR_EMAIL: 'test@test',
  GIT_COMMITTER_NAME: 'test',
  GIT_COMMITTER_EMAIL: 'test@test',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
};

async function git(cwd: string, args: string[]): Promise<string> {
  const result = await execFileAsync('git', args, { cwd, env: gitEnv });
  return result.stdout.trim();
}

async function commitFile(repo: string, name: string, content: string, message: string) {
  await writeFile(path.join(repo, name), content);
  await git(repo, ['add', name]);
  await git(repo, ['commit', '-m', message]);
  return git(repo, ['rev-parse', 'HEAD']);
}

type RemoteOverride = {
  getAuthenticatedRemote(worktreePath: string): Promise<{ url: string }>;
  getAuthenticatedRemoteForRepo(repoUrl: string): Promise<{ url: string }>;
};

describe('LocalWorktreeManager real Git regressions', () => {
  let root: string;
  let remote: string;
  let seed: string;
  let cacheDir: string;
  let worktreeDir: string;
  let manager: LocalWorktreeManager;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'autopod-worktree-git-'));
    remote = path.join(root, 'remote.git');
    seed = path.join(root, 'seed');
    cacheDir = path.join(root, 'cache');
    worktreeDir = path.join(root, 'worktrees');
    await git(root, ['init', '--bare', '--initial-branch=main', remote]);
    await git(root, ['clone', remote, seed]);
    await commitFile(seed, 'base.txt', 'base\n', 'base');
    await git(seed, ['push', 'origin', 'HEAD:refs/heads/main']);
    manager = new LocalWorktreeManager({ cacheDir, worktreeDir, logger });
    const override = manager as unknown as RemoteOverride;
    override.getAuthenticatedRemote = async () => ({ url: remote });
    override.getAuthenticatedRemoteForRepo = async () => ({ url: remote });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function createRebasedFeature(sessionId: string) {
    const result = await manager.create({
      repoUrl: 'https://github.com/org/repo.git',
      branch: 'feature',
      baseBranch: 'main',
      sessionId,
    });
    await commitFile(result.worktreePath, 'feature.txt', 'one\n', 'feature');
    await manager.pushBranch(result.worktreePath, 'feature');
    await git(result.worktreePath, [
      'fetch',
      remote,
      '+refs/heads/feature:refs/remotes/origin/feature',
    ]);
    await writeFile(path.join(result.worktreePath, 'feature.txt'), 'rebased\n');
    await git(result.worktreePath, ['commit', '-am', 'rewrite feature']);
    return result.worktreePath;
  }

  it('inspects retained source and dirty edits without publishing or altering the remote', async () => {
    const worktree = await createRebasedFeature('source-inspection');
    const remoteBefore = await git(remote, ['rev-parse', 'refs/heads/feature']);
    const commitSha = await git(worktree, ['rev-parse', 'HEAD']);
    const treeSha = await git(worktree, ['rev-parse', 'HEAD^{tree}']);
    expect(await manager.inspectSource(worktree, 'feature')).toEqual({
      branch: 'feature',
      commitSha,
      treeSha,
      worktreeClean: true,
    });
    await writeFile(path.join(worktree, 'new-unpublished.txt'), 'retain this work');
    expect(await manager.inspectSource(worktree, 'feature')).toEqual({
      branch: 'feature',
      commitSha,
      treeSha,
      worktreeClean: false,
    });
    await expect(manager.inspectSource(worktree, 'wrong-branch')).rejects.toThrow(
      'identity changed',
    );
    expect(await git(remote, ['rev-parse', 'refs/heads/feature'])).toBe(remoteBefore);
  });

  it('force-pushes to a URL when the explicit remote OID lease still matches', async () => {
    const worktree = await createRebasedFeature('lease-success');

    const receipt = await manager.pushBranch(worktree, 'feature', { force: true });
    expect(receipt).toMatchObject({
      commitSha: await git(worktree, ['rev-parse', 'HEAD']),
      treeSha: await git(worktree, ['rev-parse', 'HEAD^{tree}']),
      remoteRef: 'refs/heads/feature',
      observedRemoteCommitSha: await git(remote, ['rev-parse', 'refs/heads/feature']),
      worktreeClean: true,
    });

    expect(await git(remote, ['rev-parse', 'refs/heads/feature'])).toBe(
      await git(worktree, ['rev-parse', 'HEAD']),
    );
  });

  it.each(['push', 'commit-and-push'] as const)(
    'reconciles real %s interrupted before confirmation after database reopen',
    async (mode) => {
      const worktree = await createRebasedFeature('publication-recovery');
      if (mode === 'commit-and-push') {
        await git(worktree, ['config', 'user.name', 'Publication Fixture']);
        await git(worktree, ['config', 'user.email', 'publication@example.invalid']);
        await writeFile(
          path.join(worktree, 'feature.txt'),
          'uncommitted source for durable delivery\n',
        );
      }
      const db = createTestDb();
      insertTestProfile(db);
      const repo = createPodRepository(db);
      repo.insert({
        id: 'source',
        profileName: 'test-profile',
        task: 'Publish captured source',
        model: 'model',
        runtime: 'codex',
        branch: 'feature',
        userId: 'user',
        status: 'validated',
        executionTarget: 'local',
        maxValidationAttempts: 3,
        skipValidation: false,
        outputMode: 'pr',
      });
      repo.update('source', { worktreePath: worktree, containerId: 'retained-source' });
      const pod = repo.getOrThrow('source');
      const ledger = createSourcePublicationLedger(db);
      const interrupted = {
        ...createMockWorktreeManager(),
        pushBranch: async (...args: Parameters<typeof manager.pushBranch>) => {
          await manager.pushBranch(...args);
          throw new Error('response lost before receipt');
        },
      };
      interrupted.mergeBranch = async (config) => {
        await manager.mergeBranch(config);
        throw new Error('response lost before receipt');
      };
      const publish = (
        target: ReturnType<typeof createSourcePublicationLedger>,
        transport: WorktreeManager,
      ) =>
        mode === 'push'
          ? publishSource(target, pod, `file://${remote}`, transport)
          : publishCommittedSource(target, pod, `file://${remote}`, transport, {
              worktreePath: worktree,
              targetBranch: 'feature',
              maxDeletions: 0,
              commitMessage: 'Preserve fixture source',
            });
      const databasePath = path.join(root, 'publication.db');
      try {
        await expect(publish(ledger, interrupted)).rejects.toThrow('response lost');
        const { id } = db.prepare('SELECT id FROM source_publication_intents').get() as {
          id: string;
        };
        expect(ledger.get(id)).toMatchObject({ state: 'admitted', receipt: null });
        expect(await git(remote, ['rev-parse', 'refs/heads/feature'])).toBe(
          await git(worktree, ['rev-parse', 'HEAD']),
        );
        await db.backup(databasePath);
        db.close();
        const reopened = new Database(databasePath);
        try {
          const resumed = createSourcePublicationLedger(reopened);
          expect(resumed.get(id)).toMatchObject({ state: 'admitted', receipt: null });
          const { publicationId, ...receipt } = await publish(resumed, manager);
          expect(publicationId).toBe(id);
          expect(resumed.get(id)).toMatchObject({ state: 'confirmed', receipt });
          expect(
            reopened.prepare('SELECT count(*) AS n FROM source_publication_intents').get(),
          ).toEqual({ n: 1 });
          expect(
            reopened.prepare('SELECT count(*) AS n FROM source_publication_receipts').get(),
          ).toEqual({ n: 1 });
          expect(reopened.pragma('integrity_check', { simple: true })).toBe('ok');
        } finally {
          reopened.close();
        }
      } finally {
        if (db.open) db.close();
      }
    },
  );

  it('returns exact committed-source proof after guarded auto-commit and publication', async () => {
    const worktree = await createRebasedFeature('commit-publication');
    await git(worktree, ['config', 'user.name', 'Publication Fixture']);
    await git(worktree, ['config', 'user.email', 'publication@example.invalid']);
    await writeFile(path.join(worktree, 'feature.txt'), 'work to preserve before delivery\n');
    const receipt = await manager.mergeBranch({
      worktreePath: worktree,
      targetBranch: 'feature',
      maxDeletions: 0,
      commitMessage: 'Preserve fixture source',
    });
    expect(receipt).toMatchObject({
      commitSha: await git(worktree, ['rev-parse', 'HEAD']),
      treeSha: await git(worktree, ['rev-parse', 'HEAD^{tree}']),
      observedRemoteCommitSha: await git(remote, ['rev-parse', 'refs/heads/feature']),
      worktreeClean: true,
    });
    expect(await git(worktree, ['status', '--porcelain'])).toBe('');
    expect(await git(remote, ['show', 'refs/heads/feature:feature.txt'])).toBe(
      'work to preserve before delivery',
    );
  });

  it('rejects uncommitted work before publishing and retains the source file', async () => {
    const worktree = await createRebasedFeature('dirty-source');
    const originalRemote = await git(remote, ['rev-parse', 'refs/heads/feature']);
    await writeFile(path.join(worktree, 'feature.txt'), 'uncommitted work\n');
    await expect(manager.pushBranch(worktree, 'feature')).rejects.toMatchObject({
      code: 'SOURCE_PUBLICATION_RECONCILIATION_REQUIRED',
    });
    expect(await git(remote, ['rev-parse', 'refs/heads/feature'])).toBe(originalRemote);
    expect(await git(worktree, ['diff', '--', 'feature.txt'])).toContain('uncommitted work');
  });

  it('rejects a force push when the remote branch advanced after the tracked OID', async () => {
    const worktree = await createRebasedFeature('lease-reject');
    await git(seed, ['fetch', 'origin', 'feature:feature']);
    await git(seed, ['checkout', 'feature']);
    const concurrentOid = await commitFile(seed, 'concurrent.txt', 'other\n', 'concurrent');
    await git(seed, ['push', 'origin', 'feature']);

    await expect(manager.pushBranch(worktree, 'feature', { force: true })).rejects.toThrow();
    expect(await git(remote, ['rev-parse', 'refs/heads/feature'])).toBe(concurrentOid);
  });

  it('succeeds when remote already matches HEAD despite a stale tracked OID', async () => {
    const worktree = await createRebasedFeature('lease-idempotent');
    const staleTrackedOid = await git(worktree, ['rev-parse', 'refs/remotes/origin/feature']);
    const localOid = await git(worktree, ['rev-parse', 'HEAD']);
    expect(staleTrackedOid).not.toBe(localOid);

    // Publish through the explicit URL without refreshing origin/feature, matching
    // the validation-time push followed by a second delivery attempt.
    await git(worktree, ['push', remote, 'HEAD:refs/heads/feature']);

    await manager.pushBranch(worktree, 'feature', { force: true });

    expect(await git(remote, ['rev-parse', 'refs/heads/feature'])).toBe(localOid);
    expect(await git(worktree, ['rev-parse', 'refs/remotes/origin/feature'])).toBe(staleTrackedOid);
  });

  it('materializes exact fresh remote base and start SHAs despite stale local heads', async () => {
    await manager.create({
      repoUrl: 'https://github.com/org/repo.git',
      branch: 'main',
      baseBranch: 'main',
      sessionId: 'linked-main',
    });
    await git(seed, ['checkout', '-b', 'stack-start']);
    await commitFile(seed, 'start.txt', 'old start\n', 'old start');
    await git(seed, ['push', 'origin', 'stack-start']);
    await manager.create({
      repoUrl: 'https://github.com/org/repo.git',
      branch: 'stack-start',
      baseBranch: 'main',
      startBranch: 'stack-start',
      sessionId: 'linked-start',
    });

    await git(seed, ['checkout', 'main']);
    const freshMainOid = await commitFile(seed, 'fresh.txt', 'fresh\n', 'fresh main');
    await git(seed, ['push', 'origin', 'main']);
    await git(seed, ['checkout', 'stack-start']);
    const freshStartOid = await commitFile(seed, 'start.txt', 'fresh start\n', 'fresh start');
    await git(seed, ['push', 'origin', 'stack-start']);

    const mainResult = await manager.create({
      repoUrl: 'https://github.com/org/repo.git',
      branch: 'fresh-main-pod',
      baseBranch: 'main',
      sessionId: 'fresh-main-pod',
    });
    expect(mainResult.startCommitSha).toBe(freshMainOid);
    expect(await git(mainResult.worktreePath, ['rev-parse', 'HEAD'])).toBe(freshMainOid);
    expect(await git(mainResult.worktreePath, ['rev-parse', 'refs/heads/main'])).not.toBe(
      freshMainOid,
    );

    const startResult = await manager.create({
      repoUrl: 'https://github.com/org/repo.git',
      branch: 'fresh-start-pod',
      baseBranch: 'main',
      startBranch: 'stack-start',
      sessionId: 'fresh-start-pod',
    });
    expect(startResult.startCommitSha).toBe(freshStartOid);
    expect(await git(startResult.worktreePath, ['rev-parse', 'HEAD'])).toBe(freshStartOid);
    expect(await git(startResult.worktreePath, ['rev-parse', 'refs/remotes/origin/main'])).toBe(
      freshMainOid,
    );
    expect(await git(startResult.worktreePath, ['rev-parse', 'refs/heads/stack-start'])).not.toBe(
      freshStartOid,
    );
  });
});
