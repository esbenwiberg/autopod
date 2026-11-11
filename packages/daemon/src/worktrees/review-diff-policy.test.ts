import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ContainerManager } from '../interfaces/container-manager.js';
import { computePodDiff } from '../pods/pod-diff-fetcher.js';
import { LocalWorktreeManager } from './local-worktree-manager.js';

const exec = promisify(execFile);
const logger = pino({ level: 'silent' });
let directory: string;
let base: string;
let manager: LocalWorktreeManager;

async function git(...args: string[]) {
  return exec('git', args, { cwd: directory });
}

beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'autopod-review-diff-'));
  await git('init', '-b', 'main');
  await git('config', 'user.name', 'Synthetic review fixture');
  await git('config', 'user.email', 'review@example.invalid');
  const dependencies = Object.fromEntries(
    Array.from({ length: 2000 }, (_, i) => [`synthetic-${i}`, { version: '1.0.0' }]),
  );
  const lock = (version: string) =>
    `${JSON.stringify({ version, packages: { '': { version }, ...dependencies } }, null, 2)}\n`;
  await fs.mkdir(path.join(directory, '.serena'));
  await fs.writeFile(path.join(directory, 'package-lock.json'), lock('0.8.0'));
  await fs.writeFile(path.join(directory, 'bundle.min.js'), 'const version="0.8.0";\n');
  await fs.writeFile(path.join(directory, '.serena', 'cache.json'), '{"cached":false}\n');
  await git('add', '.');
  await git('commit', '-m', 'synthetic baseline');
  base = (await git('rev-parse', 'HEAD')).stdout.trim();
  await fs.writeFile(path.join(directory, 'package-lock.json'), lock('0.9.0-dev.0'));
  await fs.writeFile(path.join(directory, 'bundle.min.js'), 'const version="0.9.0-dev.0";\n');
  await fs.writeFile(path.join(directory, '.serena', 'cache.json'), '{"cached":true}\n');
  manager = new LocalWorktreeManager({
    cacheDir: path.join(directory, 'cache'),
    worktreeDir: path.join(directory, 'worktrees'),
    logger,
  });
});

afterEach(async () => {
  await fs.rm(directory, { recursive: true, force: true });
});

function expectReviewHunks(diff: string) {
  expect(diff).toContain('diff --git a/package-lock.json b/package-lock.json');
  expect(diff).toContain('-  "version": "0.8.0"');
  expect(diff).toContain('+  "version": "0.9.0-dev.0"');
  expect(diff).toContain('diff --git a/bundle.min.js b/bundle.min.js');
  expect(diff).not.toContain('synthetic-1999');
  expect(diff).not.toContain('.serena/cache.json');
  expect(diff.length).toBeLessThan(2000);
}

describe('review diffs versus noise-filtered previews (real Git)', () => {
  it('includes changed lockfile hunks by default on the host, not the entire large file', async () => {
    expectReviewHunks(await manager.getDiff(directory, 'main', undefined, base));
  });

  it('keeps the explicit preview filter separate from review evidence', async () => {
    const preview = await manager.getDiff(directory, 'main', undefined, base, 'preview');
    expect(preview).toBe('');
    expectReviewHunks(await manager.getDiff(directory, 'main', undefined, base, 'review'));
  });

  it('passes the review policy to container Git and to the host fallback', async () => {
    const containerManager = {
      execInContainer: vi.fn(async (_id: string, args: string[]) => {
        const { stdout, stderr } = await git(...args.slice(1));
        return { stdout, stderr, exitCode: 0 };
      }),
    } as unknown as ContainerManager;
    const input = {
      pod: { containerId: 'fixture', worktreePath: directory, startCommitSha: base },
      defaultBranch: 'main',
      purpose: 'review' as const,
      containerManager,
      worktreeManager: manager,
    };
    const live = await computePodDiff(input);
    expect(live.source).toBe('container');
    expectReviewHunks(live.diff);
    vi.mocked(containerManager.execInContainer).mockRejectedValue(
      new Error('fixture disconnected'),
    );
    const saved = await computePodDiff(input);
    expect(saved.source).toBe('worktree');
    expectReviewHunks(saved.diff);
  });

  it('does not classify lockfile-only changes as no work', async () => {
    await git('checkout', '--', 'bundle.min.js', '.serena/cache.json');
    expect(await manager.hasChangesAgainstBase(directory, 'main')).toBe(true);
    expect(await manager.getChangedPathsAgainstBase(directory, 'main')).toEqual([
      'package-lock.json',
    ]);
    expect(await manager.getDiffStats(directory, 'main', base)).toEqual({
      filesChanged: 1,
      linesAdded: 2,
      linesRemoved: 2,
    });
    await git('add', 'package-lock.json');
    await git('commit', '-m', 'synthetic lockfile-only change');
    const head = (await git('rev-parse', 'HEAD')).stdout.trim();
    const tree = (await git('rev-parse', 'HEAD^{tree}')).stdout.trim();
    expect(await manager.classifyCanonicalDiff(directory, base, head, tree)).toMatchObject({
      outcome: 'changed',
      stats: { filesChanged: 1, linesAdded: 2, linesRemoved: 2 },
    });
  });
});
