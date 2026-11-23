import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RunGit } from './bare-push.js';
import { proveRebaseRewrite } from './rebase-rewrite-proof.js';

const run = promisify(execFile);

const env = {
  ...process.env,
  GIT_AUTHOR_NAME: 'author',
  GIT_AUTHOR_EMAIL: 'author@test',
  GIT_COMMITTER_NAME: 'committer',
  GIT_COMMITTER_EMAIL: 'committer@test',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_EDITOR: 'true',
};

let repo: string;

async function git(args: string[], extraEnv: Record<string, string> = {}) {
  return (await run('git', args, { cwd: repo, env: { ...env, ...extraEnv } })).stdout.trim();
}

const runGit: RunGit = async (args) => {
  try {
    const r = await run('git', args, { cwd: repo, env });
    return { stdout: r.stdout, stderr: r.stderr, exitCode: 0 };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; code?: number };
    return {
      stdout: e.stdout ?? '',
      stderr: e.stderr ?? String(err),
      exitCode: typeof e.code === 'number' ? e.code : 1,
    };
  }
};

let clock = 1_800_000_000;
async function commit(files: Record<string, string>, message: string) {
  for (const [name, bytes] of Object.entries(files)) await writeFile(path.join(repo, name), bytes);
  await git(['add', '-A']);
  clock += 60;
  const date = `${clock} +0000`;
  await git(['commit', '-m', message], { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date });
  return git(['rev-parse', 'HEAD']);
}

/** main: base; feature (P): two commits; main then moves with a conflicting edit. */
async function scenario() {
  await git(['init', '-q', '--initial-branch=main', repo]);
  await commit({ 'shared.txt': 'base\n', 'other.txt': 'x\n' }, 'base');
  await git(['checkout', '-q', '-b', 'feature']);
  await commit({ 'shared.txt': 'feature\n' }, 'feature edits shared');
  await commit({ 'feature.txt': 'feature\n' }, 'feature adds file');
  const predecessor = await git(['rev-parse', 'HEAD']);
  await git(['checkout', '-q', 'main']);
  await commit({ 'shared.txt': 'main\n' }, 'main edits shared');
  await commit({ 'main.txt': 'main\n' }, 'main adds file');
  await git(['update-ref', 'refs/remotes/origin/main', 'main']);
  return { predecessor, baseRef: 'refs/remotes/origin/main' };
}

/** Rebase `feature` onto main, resolving the shared.txt conflict. Returns R. */
async function rebaseWithResolution() {
  await git(['checkout', '-q', 'feature']);
  try {
    await git(['rebase', 'main']);
  } catch {
    await writeFile(path.join(repo, 'shared.txt'), 'main + feature\n');
    await git(['add', 'shared.txt']);
    await git(['rebase', '--continue']);
  }
  return git(['rev-parse', 'HEAD']);
}

describe('proveRebaseRewrite', () => {
  beforeEach(async () => {
    repo = await mkdtemp(path.join(os.tmpdir(), 'autopod-rebase-proof-'));
  });
  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  it('accepts a conflict-resolved rebase onto a newer base and reports how commits were accounted for', async () => {
    const { predecessor, baseRef } = await scenario();
    const candidate = await rebaseWithResolution();
    const proof = await proveRebaseRewrite(runGit, { predecessor, candidate, baseRef });
    expect(proof).toMatchObject({
      ok: true,
      predecessor,
      candidate,
      baseRef,
      baseTip: await git(['rev-parse', 'main']),
      predecessorFork: await git(['rev-parse', 'main~2']),
      candidateFork: await git(['rev-parse', 'main']),
      patchEquivalent: 1,
      fingerprintMatched: 1,
    });
  });

  it('accepts a rebase with an extra agent commit and a base ref refreshed past the rebase point', async () => {
    const { predecessor, baseRef } = await scenario();
    await rebaseWithResolution();
    const candidate = await commit({ 'agent.txt': 'follow-up\n' }, 'agent follow-up');
    await git(['checkout', '-q', 'main']);
    await commit({ 'later.txt': 'later\n' }, 'base moved again');
    await git(['update-ref', baseRef, 'main']);
    const proof = await proveRebaseRewrite(runGit, { predecessor, candidate, baseRef });
    expect(proof).toMatchObject({ ok: true, patchEquivalent: 1, fingerprintMatched: 1 });
  });

  it('accepts dropping a merge of base and counts commits that landed upstream as patch-equivalent', async () => {
    const { baseRef } = await scenario();
    await git(['checkout', '-q', 'feature']);
    await commit({ 'upstreamed.txt': 'same\n' }, 'feature fix later cherry-picked');
    const upstreamed = await git(['rev-parse', 'HEAD']);
    try {
      await git(['merge', '-q', 'main', '-m', 'merge main']);
    } catch {
      await writeFile(path.join(repo, 'shared.txt'), 'merged\n');
      await git(['add', 'shared.txt']);
      await git(['commit', '-q', '--no-edit']);
    }
    const predecessor = await git(['rev-parse', 'HEAD']);
    await git(['checkout', '-q', 'main']);
    await git(['cherry-pick', upstreamed]);
    await git(['update-ref', baseRef, 'main']);
    const candidate = await rebaseWithResolution();
    const proof = await proveRebaseRewrite(runGit, { predecessor, candidate, baseRef });
    expect(proof).toMatchObject({ ok: true, fingerprintMatched: 1 });
    if (proof.ok) expect(proof.patchEquivalent).toBe(2);
  });

  it.each([
    [
      'a dropped commit',
      async () => {
        await rebaseWithResolution();
        await git(['reset', '-q', '--hard', 'HEAD~1']);
      },
      /not accounted for/,
    ],
    [
      'squashed commits',
      async () => {
        await rebaseWithResolution();
        await git(['reset', '-q', '--soft', 'main']);
        await git(['commit', '-q', '-m', 'squashed']);
      },
      /not accounted for/,
    ],
    [
      'a reworded conflict-resolved commit',
      async () => {
        // A reworded clean replay is still patch-equivalent; only the resolved
        // commit depends on its preserved identity.
        const top = await rebaseWithResolution();
        await git(['reset', '-q', '--hard', 'HEAD~1']);
        await git(['commit', '-q', '--amend', '-m', 'renamed subject']);
        await git(['cherry-pick', top]);
      },
      /not accounted for/,
    ],
    [
      'unrelated work replacing the branch',
      async () => {
        await git(['checkout', '-q', '-B', 'feature', 'main']);
        await commit({ 'unrelated.txt': 'other\n' }, 'unrelated');
      },
      /not accounted for/,
    ],
  ] as const)('refuses %s', async (_label, mutate, reason) => {
    const { predecessor, baseRef } = await scenario();
    await mutate();
    const candidate = await git(['rev-parse', 'HEAD']);
    const proof = await proveRebaseRewrite(runGit, { predecessor, candidate, baseRef });
    expect(proof.ok).toBe(false);
    if (!proof.ok) expect(proof.reason).toMatch(reason);
  });

  it('refuses a rewrite that moves the branch backwards on its base', async () => {
    const { predecessor: featureTip, baseRef } = await scenario();
    await git(['checkout', '-q', 'feature']);
    try {
      await git(['merge', '-q', 'main', '-m', 'merge main']);
    } catch {
      await writeFile(path.join(repo, 'shared.txt'), 'merged\n');
      await git(['add', 'shared.txt']);
      await git(['commit', '-q', '--no-edit']);
    }
    const predecessor = await git(['rev-parse', 'HEAD']);
    // Replay the feature commits onto the OLD base (main~2): history moves backwards.
    await git(['checkout', '-q', '-B', 'candidate', 'main~2']);
    await git(['cherry-pick', `${featureTip}~1`, featureTip]);
    const candidate = await git(['rev-parse', 'HEAD']);
    const proof = await proveRebaseRewrite(runGit, { predecessor, candidate, baseRef });
    expect(proof).toEqual({
      ok: false,
      reason: 'candidate moves the branch backwards on its base',
    });
  });

  it('refuses when the base ref is missing or the commit bound is exceeded', async () => {
    const { predecessor, baseRef } = await scenario();
    const candidate = await rebaseWithResolution();
    expect(
      await proveRebaseRewrite(runGit, {
        predecessor,
        candidate,
        baseRef: 'refs/remotes/origin/x',
      }),
    ).toEqual({ ok: false, reason: 'base ref refs/remotes/origin/x unavailable' });
    expect(
      await proveRebaseRewrite(runGit, { predecessor, candidate, baseRef, maxCommits: 1 }),
    ).toEqual({ ok: false, reason: 'more than 1 predecessor commits to account for' });
  });
});
