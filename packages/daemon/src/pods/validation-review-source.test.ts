import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { AutopodError } from '@autopod/shared';
import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LocalWorktreeManager } from '../worktrees/local-worktree-manager.js';
import {
  buildDirtySourceCorrection,
  captureReviewSource,
  isReviewSourceDirtyReason,
  ReviewSourceDirtyError,
  summarizeReviewSourceChanges,
} from './validation-review-source.js';

const exec = promisify(execFile);
let directory: string;
let manager: LocalWorktreeManager;

async function git(...args: string[]) {
  return exec('git', args, { cwd: directory });
}

function capture(log?: { warn: ReturnType<typeof vi.fn> }) {
  return captureReviewSource(manager, directory, 'feature', 'main', undefined, undefined, log);
}

beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'autopod-review-source-'));
  await git('init', '-b', 'main');
  await git('config', 'user.name', 'Synthetic review fixture');
  await git('config', 'user.email', 'review@example.invalid');
  await fs.writeFile(path.join(directory, 'app.ts'), 'export const value = 1;\n');
  await git('add', '.');
  await git('commit', '-m', 'baseline');
  await git('checkout', '-b', 'feature');
  await fs.writeFile(path.join(directory, 'app.ts'), 'export const value = 2;\n');
  await git('commit', '-am', 'feat: change value');
  manager = new LocalWorktreeManager({
    cacheDir: path.join(directory, '.cache-outside'),
    worktreeDir: path.join(directory, '.worktrees-outside'),
    logger: pino({ level: 'silent' }),
  });
});

afterEach(async () => {
  await fs.rm(directory, { recursive: true, force: true });
});

describe('captureReviewSource (real Git)', () => {
  it('binds clean committed source', async () => {
    const result = await capture();
    expect(result.diff).toContain('export const value = 2;');
    expect(result.reviewSource?.head).toBe((await git('rev-parse', 'HEAD')).stdout.trim());
  });

  it('names untracked agent notes instead of an opaque unavailable failure', async () => {
    await fs.mkdir(path.join(directory, 'thoughts'));
    await fs.writeFile(path.join(directory, 'thoughts', 'plan.md'), 'scratch\n');
    await fs.writeFile(path.join(directory, 'thoughts', 'notes.md'), 'scratch\n');
    const log = { warn: vi.fn() };
    const error = await capture(log).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ReviewSourceDirtyError);
    expect(error).toMatchObject({
      code: 'REVIEW_SOURCE_DIRTY',
      changes: { untracked: ['thoughts/'], changed: [] },
      summary: 'untracked: 1 path under thoughts/',
    });
    expect((error as Error).message).toContain(
      'Review source has uncommitted files (untracked: 1 path under thoughts/)',
    );
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'REVIEW_SOURCE_DIRTY' }),
      'Review source is dirty',
    );
  });

  it('reports uncommitted tracked changes', async () => {
    await fs.writeFile(path.join(directory, 'app.ts'), 'export const value = 3;\n');
    await expect(capture()).rejects.toMatchObject({
      code: 'REVIEW_SOURCE_DIRTY',
      changes: { untracked: [], changed: ['app.ts'] },
      summary: 'uncommitted: 1 path at root',
    });
  });

  it('keeps a path-free cause for non-dirty failures', async () => {
    await git('checkout', '-b', 'other');
    const error = await capture().catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: 'REVIEW_SOURCE_UNAVAILABLE' });
    expect((error as Error).message).toContain(
      '(Source branch/cleanliness unavailable; preserve and reconcile it before adoption.)',
    );
  });
});

describe('captureReviewSource causes', () => {
  const base = {
    getDiff: vi.fn(async () => ''),
    getCommitLog: vi.fn(async () => ''),
    getChangedPathsAgainstBase: vi.fn(async () => []),
  };

  it('does not echo raw Git errors and records source drift', async () => {
    const raw = {
      ...base,
      inspectSourceAdoption: vi.fn(async () => {
        throw new Error('fatal: /secret/path/token@host not found');
      }),
    };
    const error = await captureReviewSource(raw, '/w', 'b', 'main', undefined, undefined).catch(
      (caught: unknown) => caught,
    );
    expect((error as Error).message).toContain('(Git source observation failed)');
    expect((error as Error).message).not.toContain('secret');

    let call = 0;
    const drift = {
      ...base,
      inspectSourceAdoption: vi.fn(async () => ({
        branch: 'b',
        commitSha: call++ === 0 ? 'a'.repeat(40) : 'b'.repeat(40),
        treeSha: 'c'.repeat(40),
        worktreeClean: true,
      })),
    };
    await expect(
      captureReviewSource(drift, '/w', 'b', 'main', undefined, undefined),
    ).rejects.toThrow('(Source changed while computing review input)');
  });

  it('falls back to the generic cause when the dirty diagnosis is unavailable', async () => {
    const blocked = {
      ...base,
      inspectSourceAdoption: vi.fn(async () => {
        throw new AutopodError(
          'Submodules need recursive source custody',
          'SOURCE_ADOPTION_BLOCKED',
        );
      }),
      inspectSourcePreservation: vi.fn(async () => {
        throw new Error('unavailable');
      }),
    };
    await expect(
      captureReviewSource(blocked, '/w', 'b', 'main', undefined, undefined),
    ).rejects.toMatchObject({
      code: 'REVIEW_SOURCE_UNAVAILABLE',
      message: expect.stringContaining('(Submodules need recursive source custody)'),
    });
  });
});

describe('dirty review source messages', () => {
  it('summarizes by top-level location and bounds the agent path list', () => {
    expect(
      summarizeReviewSourceChanges({
        untracked: ['thoughts/', 'notes.md', 'b/x', 'c/y', 'd/z'],
        changed: ['src/a.ts', 'src/b.ts'],
      }),
    ).toBe(
      'untracked: 1 path at root, 1 path under b/, 1 path under c/, 2 more locations; uncommitted: 2 paths under src/',
    );
    const correction = buildDirtySourceCorrection({
      untracked: Array.from({ length: 32 }, (_, i) => `tmp/f${i}\u0007.md`),
      changed: ['src/a.ts'],
    });
    expect(correction).toContain('- `tmp/f0?.md`');
    expect(correction).toContain('…and 2 more');
    expect(correction).toContain('Uncommitted changes to tracked paths:\n- `src/a.ts`');
    expect(correction).toContain('.git/info/exclude');
    expect(correction).not.toContain('\u0007');
  });

  it('recognizes its own failure reason only', () => {
    expect(
      isReviewSourceDirtyReason(
        new ReviewSourceDirtyError({ untracked: ['a'], changed: [] }).message,
      ),
    ).toBe(true);
    expect(isReviewSourceDirtyReason('Review source could not be read consistently')).toBe(false);
    expect(isReviewSourceDirtyReason(null)).toBe(false);
  });
});
