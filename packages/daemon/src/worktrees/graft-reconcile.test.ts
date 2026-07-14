import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RunGit } from './bare-push.js';
import { graftHostTreeOntoBase } from './graft-reconcile.js';

const execFileAsync = promisify(execFile);

const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: 'test',
  GIT_AUTHOR_EMAIL: 'test@test',
  GIT_COMMITTER_NAME: 'test',
  GIT_COMMITTER_EMAIL: 'test@test',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
};

async function git(cwd: string, args: string[]) {
  return execFileAsync('git', args, { cwd, env: gitEnv });
}

async function tryGit(
  cwd: string,
  args: string[],
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  try {
    const r = await execFileAsync('git', args, { cwd, env: gitEnv });
    return { stdout: r.stdout, stderr: r.stderr, exitCode: 0 };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; code?: number };
    return {
      stdout: e.stdout ?? '',
      stderr: e.stderr ?? (err as Error).message,
      exitCode: typeof e.code === 'number' ? e.code : 1,
    };
  }
}

function runGitIn(cwd: string): RunGit {
  return (args) => tryGit(cwd, args);
}

async function revParse(cwd: string, ref: string): Promise<string> {
  const { stdout } = await git(cwd, ['rev-parse', ref]);
  return stdout.trim();
}

async function fileAt(cwd: string, ref: string, file: string): Promise<string | null> {
  const r = await tryGit(cwd, ['show', `${ref}:${file}`]);
  return r.exitCode === 0 ? r.stdout : null;
}

describe('graftHostTreeOntoBase', () => {
  let tmpRoot: string;

  beforeEach(async () => {
    tmpRoot = await mkdtemp(path.join(os.tmpdir(), 'autopod-graft-'));
  });

  afterEach(async () => {
    await rm(tmpRoot, { recursive: true, force: true });
  });

  /**
   * Reproduces the sandbox divergence: `base` (container HEAD) and the host's
   * auto-commit both descend from a shared root but sit on sibling branches,
   * so neither is an ancestor of the other. The host commit carries the agent's
   * real working-tree content.
   */
  async function buildDivergedRepo() {
    const repo = path.join(tmpRoot, 'repo');
    await git(tmpRoot, ['init', '--initial-branch=main', repo]);
    await writeFile(path.join(repo, 'root.txt'), 'root\n');
    await git(repo, ['add', '.']);
    await git(repo, ['commit', '-m', 'root']);
    const root = await revParse(repo, 'HEAD');

    // Container lineage: agent's committed work (the "container HEAD").
    await writeFile(path.join(repo, 'agent.txt'), 'agent work\n');
    await git(repo, ['add', '.']);
    await git(repo, ['commit', '-m', 'agent commit']);
    const containerHead = await revParse(repo, 'HEAD');

    // Host lineage: a divergent auto-commit branched off root (NOT off container
    // HEAD), carrying the full extracted tree the daemon wants to validate.
    await git(repo, ['checkout', '-b', 'host-auto', root]);
    await writeFile(path.join(repo, 'agent.txt'), 'agent work\n'); // same content the agent produced
    await writeFile(path.join(repo, 'extra.txt'), 'auto-committed delta\n');
    await git(repo, ['add', '.']);
    await git(repo, ['commit', '-m', 'daemon auto-commit']);
    const hostHead = await revParse(repo, 'HEAD');

    return { repo, root, containerHead, hostHead };
  }

  it('grafts a divergent host tree onto the container HEAD, preserving content and ancestry', async () => {
    const { repo, containerHead, hostHead } = await buildDivergedRepo();

    // Precondition: genuinely diverged.
    expect(
      (await tryGit(repo, ['merge-base', '--is-ancestor', containerHead, hostHead])).exitCode,
    ).not.toBe(0);
    expect(
      (await tryGit(repo, ['merge-base', '--is-ancestor', hostHead, containerHead])).exitCode,
    ).not.toBe(0);

    const hostTreeBefore = await revParse(repo, `${hostHead}^{tree}`);

    const result = await graftHostTreeOntoBase(runGitIn(repo), containerHead);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.committed).toBe(true);

    // Linear now: container HEAD is an ancestor of the grafted head.
    expect(
      (await tryGit(repo, ['merge-base', '--is-ancestor', containerHead, result.head])).exitCode,
    ).toBe(0);
    // Grafted commit's parent is exactly the container HEAD.
    expect(await revParse(repo, `${result.head}^`)).toBe(containerHead);
    // Full agent content is preserved (tree identical to the original host commit).
    expect(await revParse(repo, `${result.head}^{tree}`)).toBe(hostTreeBefore);
    expect(await fileAt(repo, result.head, 'agent.txt')).toBe('agent work\n');
    expect(await fileAt(repo, result.head, 'extra.txt')).toBe('auto-committed delta\n');
  });

  it('returns the base without an empty commit when host and base trees match', async () => {
    const repo = path.join(tmpRoot, 'repo');
    await git(tmpRoot, ['init', '--initial-branch=main', repo]);
    await writeFile(path.join(repo, 'a.txt'), 'a\n');
    await git(repo, ['add', '.']);
    await git(repo, ['commit', '-m', 'base']);
    const base = await revParse(repo, 'HEAD');

    // A sibling commit with the *same* tree content as base.
    await git(repo, ['checkout', '-b', 'sibling', 'HEAD~0']);
    await writeFile(path.join(repo, 'a.txt'), 'a\n');
    await git(repo, ['commit', '-am', 'noop-ish', '--allow-empty']);

    const result = await graftHostTreeOntoBase(runGitIn(repo), base);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.committed).toBe(false);
    expect(result.head).toBe(base);
  });

  it('fails cleanly when the base commit is not reachable on the host', async () => {
    const repo = path.join(tmpRoot, 'repo');
    await git(tmpRoot, ['init', '--initial-branch=main', repo]);
    await writeFile(path.join(repo, 'a.txt'), 'a\n');
    await git(repo, ['add', '.']);
    await git(repo, ['commit', '-m', 'base']);

    const result = await graftHostTreeOntoBase(
      runGitIn(repo),
      '0123456789012345678901234567890123456789',
    );

    expect(result).toEqual({ ok: false, reason: 'base-missing' });
  });
});
