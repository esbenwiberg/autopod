import { execFile } from 'node:child_process';
import { copyFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RunGit } from './bare-push.js';
import { transferCommitToContainer } from './sandbox-reconcile.js';

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

function runGitIn(cwd: string): RunGit {
  return async (args) => {
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
  };
}

async function revParse(cwd: string, ref: string): Promise<string> {
  const { stdout } = await git(cwd, ['rev-parse', ref]);
  return stdout.trim();
}

describe('transferCommitToContainer', () => {
  let tmpRoot: string;

  beforeEach(async () => {
    tmpRoot = await mkdtemp(path.join(os.tmpdir(), 'autopod-sbx-reconcile-'));
  });

  afterEach(async () => {
    await rm(tmpRoot, { recursive: true, force: true });
  });

  /**
   * Model the sandbox's defining property: host and container have **separate,
   * isolated git object stores** (independent clones, NO shared alternates). The
   * container is a snapshot of the host taken at `base`; the host then advances to
   * `target`. The container cannot resolve `target` until we bridge the stores.
   */
  async function buildIsolatedStores() {
    const host = path.join(tmpRoot, 'host');
    const container = path.join(tmpRoot, 'container');

    await git(tmpRoot, ['init', '--initial-branch=main', host]);
    await writeFile(path.join(host, 'a.txt'), 'a\n');
    await git(host, ['add', '.']);
    await git(host, ['commit', '-m', 'base']);
    const base = await revParse(host, 'HEAD');

    // Container is an independent clone (its own object store) at `base`.
    await git(tmpRoot, ['clone', '--no-hardlinks', host, container]);
    expect(await revParse(container, 'HEAD')).toBe(base);

    // Host advances to `target` — a commit the container's store does not have.
    await writeFile(path.join(host, 'a.txt'), 'a-reworked\n');
    await writeFile(path.join(host, 'b.txt'), 'new file\n');
    await git(host, ['add', '.']);
    await git(host, ['commit', '-m', 'host auto-commit']);
    const target = await revParse(host, 'HEAD');

    return { host, container, base, target };
  }

  it('makes an isolated container resolve a host-only commit via bundle transfer', async () => {
    const { host, container, base, target } = await buildIsolatedStores();

    // Precondition: the container genuinely cannot see `target`.
    expect((await runGitIn(container)(['cat-file', '-e', `${target}^{commit}`])).exitCode).not.toBe(
      0,
    );

    const result = await transferCommitToContainer({
      hostGit: runGitIn(host),
      containerGit: runGitIn(container),
      transferBundle: async (hostBundlePath, containerBundlePath) => {
        // Stand in for cm.writeFile(Buffer): copy the bundle across the "store boundary".
        await copyFile(hostBundlePath, containerBundlePath);
      },
      hostBundlePath: path.join(tmpRoot, 'xfer.bundle'),
      containerBundlePath: path.join(container, 'xfer.bundle'),
      transferRef: 'refs/autopod-xfer/pod-1',
      target,
      base,
    });

    expect(result).toEqual({ ok: true });
    // The container can now resolve AND reset to the host-only commit.
    expect((await runGitIn(container)(['cat-file', '-e', `${target}^{commit}`])).exitCode).toBe(0);
    await git(container, ['reset', '--hard', target]);
    expect(await revParse(container, 'HEAD')).toBe(target);
    const { stdout } = await git(container, ['show', `${target}:b.txt`]);
    expect(stdout).toBe('new file\n');
    // Throwaway transfer refs are cleaned up on both ends.
    expect(
      (await runGitIn(host)(['rev-parse', '--verify', 'refs/autopod-xfer/pod-1'])).exitCode,
    ).not.toBe(0);
    expect(
      (await runGitIn(container)(['rev-parse', '--verify', 'refs/autopod-xfer/pod-1'])).exitCode,
    ).not.toBe(0);
  });

  it('fails cleanly when the bundle transfer step throws', async () => {
    const { host, container, base, target } = await buildIsolatedStores();

    const result = await transferCommitToContainer({
      hostGit: runGitIn(host),
      containerGit: runGitIn(container),
      transferBundle: async () => {
        throw new Error('sandbox files API 500');
      },
      hostBundlePath: path.join(tmpRoot, 'xfer.bundle'),
      containerBundlePath: path.join(container, 'xfer.bundle'),
      transferRef: 'refs/autopod-xfer/pod-1',
      target,
      base,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('transfer:');
    // Host throwaway ref cleaned up even on failure.
    expect(
      (await runGitIn(host)(['rev-parse', '--verify', 'refs/autopod-xfer/pod-1'])).exitCode,
    ).not.toBe(0);
  });

  it('fails cleanly when the base prerequisite is missing in the container', async () => {
    const { host, container, target } = await buildIsolatedStores();
    // Use a bogus base the container does not have → bundle prerequisites unsatisfiable on fetch.
    const bogusBase = '0000000000000000000000000000000000000000';

    const result = await transferCommitToContainer({
      hostGit: runGitIn(host),
      containerGit: runGitIn(container),
      transferBundle: async (h, c) => {
        await copyFile(h, c);
      },
      hostBundlePath: path.join(tmpRoot, 'xfer.bundle'),
      containerBundlePath: path.join(container, 'xfer.bundle'),
      transferRef: 'refs/autopod-xfer/pod-1',
      target,
      base: bogusBase,
    });

    // Either the host bundle step or the container fetch rejects — never a silent success.
    expect(result.ok).toBe(false);
  });
});
