import { execFile } from 'node:child_process';
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  assertFinalizationPathAvailable,
  createRetainedFinalizationRepository,
  finalizationSourceLocations,
} from '../pods/retained-finalization-repository.js';
import { createTestDb, logger } from '../test-utils/mock-helpers.js';
import { LocalWorktreeManager } from './local-worktree-manager.js';

const exec = promisify(execFile);
const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const close of cleanup.splice(0)) await close();
});
async function fixture() {
  const db = createTestDb();
  cleanup.push(() => db.close());
  const root = await mkdtemp(path.join(os.tmpdir(), 'retained-paths-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  // A durable path claim is authoritative even when mutable pod metadata is absent.
  const hold = (locations: string[]) =>
    createRetainedFinalizationRepository(db).admit(
      {
        fingerprint: 'a'.repeat(64),
        generation: 1,
        containerId: null,
        target: 'local',
        worktreePath: locations[0] ?? null,
        resources: [],
        taskId: 'task',
        owners: [{ kind: 'continuation', id: 'owner' }],
        sourceLocations: finalizationSourceLocations(locations),
      },
      {
        podId: 'held',
        request: {
          requestKey: 'retained-paths',
          expectedGeneration: 1,
          expectedBinding: 'a'.repeat(64),
          mode: 'stop-retain',
          reason: 'Preserve this exact source location',
        },
        actor: { type: 'human', userId: 'fixture' },
        state: 'pending',
        createdAt: new Date().toISOString(),
        finalizedAt: null,
        message: 'Retained',
        resourcesRetained: true,
      },
      'request-hash',
      null,
    );
  const assertPathMutable = (location: string) => assertFinalizationPathAvailable(db, location);
  return { root, hold, assertPathMutable };
}
const git = (cwd: string, ...args: string[]) =>
  exec('git', args, {
    cwd,
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_TERMINAL_PROMPT: '0',
    },
  });

async function materializedFixture(hold = true) {
  const f = await fixture();
  const origin = path.join(f.root, 'origin');
  await mkdir(origin);
  await git(origin, 'init', '-b', 'main');
  await git(origin, 'config', 'user.name', 'Fixture');
  await git(origin, 'config', 'user.email', 'fixture@example.invalid');
  await writeFile(path.join(origin, 'source.txt'), 'original task source');
  await git(origin, 'add', 'source.txt');
  await git(origin, 'commit', '-m', 'fixture');
  const manager = new LocalWorktreeManager({
    cacheDir: path.join(f.root, 'cache'),
    worktreeDir: path.join(f.root, 'worktrees'),
    logger,
    assertPathMutable: f.assertPathMutable,
  });
  // Replace only remote authentication with a local fixture; Git and filesystem
  // operations, including the conflict cleanup being tested, remain real.
  vi.spyOn(
    manager as unknown as {
      getAuthenticatedRemoteForRepo(url: string): Promise<{ url: string }>;
    },
    'getAuthenticatedRemoteForRepo',
  ).mockResolvedValue({ url: origin });
  const source = await manager.create({
    repoUrl: origin,
    branch: 'retained',
    baseBranch: 'main',
    sessionId: 'held',
  });
  await writeFile(path.join(source.worktreePath, 'report.json'), 'unpublished report evidence');
  if (hold) f.hold([source.worktreePath]);
  return { f, origin, manager, source };
}

describe('retained source location protection', () => {
  it('preserves real Git source, reports and common storage during same-branch orphan cleanup', async () => {
    const { origin, manager, source } = await materializedFixture();
    await expect(
      manager.create({
        repoUrl: origin,
        branch: 'retained',
        baseBranch: 'main',
        sessionId: 'different-task',
      }),
    ).rejects.toMatchObject({ code: 'RETAINED_FINALIZATION_BLOCKED' });
    await expect(manager.cleanup(source.worktreePath)).rejects.toMatchObject({
      code: 'RETAINED_FINALIZATION_BLOCKED',
    });
    await expect(manager.cleanup(source.bareRepoPath)).rejects.toMatchObject({
      code: 'RETAINED_FINALIZATION_BLOCKED',
    });
    expect(await readFile(path.join(source.worktreePath, 'source.txt'), 'utf8')).toBe(
      'original task source',
    );
    expect(await readFile(path.join(source.worktreePath, 'report.json'), 'utf8')).toBe(
      'unpublished report evidence',
    );
    expect((await git(source.worktreePath, 'rev-parse', 'HEAD')).stdout.trim()).toBe(
      source.startCommitSha,
    );
    expect((await git(source.bareRepoPath, 'worktree', 'list', '--porcelain')).stdout).toContain(
      source.worktreePath,
    );
  });

  it.each([
    { name: 'held before unmount', holdBeforeMove: true, autoGc: false },
    { name: 'already unavailable at admission', holdBeforeMove: false, autoGc: false },
    { name: 'automatic GC during fetch', holdBeforeMove: true, autoGc: true },
  ])('preserves unavailable linked-worktree metadata: $name', async ({
    holdBeforeMove,
    autoGc,
  }) => {
    const { f, origin, manager, source } = await materializedFixture(holdBeforeMove);
    const pointer = await readFile(path.join(source.worktreePath, '.git'), 'utf8');
    const admin = path.resolve(source.worktreePath, pointer.trim().replace(/^gitdir: /, ''));
    const head = await readFile(path.join(admin, 'HEAD'), 'utf8');
    // Exercise immediate eligibility rather than waiting for Git's default expiry.
    await git(source.bareRepoPath, 'config', 'gc.worktreePruneExpire', 'now');
    const offline = path.join(f.root, 'temporarily-offline');
    await rename(source.worktreePath, offline);
    if (!holdBeforeMove) f.hold([source.worktreePath]);
    if (autoGc) {
      await git(source.bareRepoPath, 'repack', '-ad');
      await git(source.bareRepoPath, 'config', 'gc.autoPackLimit', '1');
      await git(source.bareRepoPath, 'config', 'gc.autoDetach', 'false');
      await git(source.bareRepoPath, 'config', 'fetch.unpackLimit', '1');
      await writeFile(path.join(origin, 'additional.txt'), 'independent upstream commit');
      await git(origin, 'add', 'additional.txt');
      await git(origin, 'commit', '-m', 'advance independent main');
    }
    const other = await manager.create({
      repoUrl: origin,
      branch: 'other',
      baseBranch: 'main',
      sessionId: 'other',
    });
    expect(await readFile(path.join(admin, 'HEAD'), 'utf8')).toBe(head);
    if (autoGc) {
      // Two packs were eligible: automatic GC actually repacked them, without pruning custody.
      expect(
        (await readdir(path.join(source.bareRepoPath, 'objects', 'pack'))).filter((name) =>
          name.endsWith('.pack'),
        ),
      ).toHaveLength(1);
    }
    await manager.cleanup(other.worktreePath);
    expect(await readFile(path.join(admin, 'HEAD'), 'utf8')).toBe(head);
    await rename(offline, source.worktreePath);
    expect((await git(source.worktreePath, 'rev-parse', 'HEAD')).stdout.trim()).toBe(
      source.startCommitSha,
    );
    expect(await readFile(path.join(source.worktreePath, 'report.json'), 'utf8')).toBe(
      'unpublished report evidence',
    );
  });

  it('protects existing aliases and missing descendants reached through a symlink', async () => {
    const f = await fixture();
    const held = path.join(f.root, 'held');
    await mkdir(held);
    f.hold([held]);
    const alias = path.join(f.root, 'alias');
    await symlink(held, alias);
    expect(() => f.assertPathMutable(alias)).toThrow(/retains this source/);
    expect(() => f.assertPathMutable(path.join(alias, 'not-created', 'source'))).toThrow(
      /retains this source/,
    );
    expect(() => f.assertPathMutable(f.root)).toThrow(/retains this source/);
    expect(() => f.assertPathMutable(path.parse(f.root).root)).toThrow(/retains this source/);
    const nested = path.join(held, 'nested');
    await mkdir(nested);
    const deepAlias = path.join(f.root, 'deep-alias');
    await symlink(nested, deepAlias);
    expect(() => f.assertPathMutable(`${deepAlias}/../missing`)).toThrow(/retains this source/);
    const dangling = path.join(f.root, 'dangling');
    await symlink(path.join(f.root, 'absent'), dangling);
    expect(() => f.assertPathMutable(path.join(dangling, 'new'))).toThrow(
      /identity is unavailable/,
    );
    expect(() => f.assertPathMutable(path.join(f.root, 'unrelated'))).not.toThrow();
  });
});
