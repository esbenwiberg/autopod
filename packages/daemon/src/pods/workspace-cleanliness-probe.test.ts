import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { probeWorkspaceCleanliness } from './workspace-cleanliness-probe.js';

const exec = promisify(execFile);
let directory: string;

async function git(...args: string[]) {
  return exec('git', args, { cwd: directory });
}

// Runs the probe's container commands against a local repository standing in for /workspace.
async function local(command: string[]) {
  const args = command.slice(1).map((arg) => (arg === '/workspace' ? directory : arg));
  try {
    const { stdout, stderr } = await exec(command[0] ?? 'git', args);
    return { stdout, stderr, exitCode: 0 };
  } catch (error) {
    const failed = error as { stdout?: string; stderr?: string; code?: number };
    return { stdout: failed.stdout ?? '', stderr: failed.stderr ?? '', exitCode: failed.code ?? 1 };
  }
}

beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'autopod-cleanliness-'));
  await git('init', '-b', 'main');
  await git('config', 'user.name', 'Synthetic fixture');
  await git('config', 'user.email', 'fixture@example.invalid');
  await fs.writeFile(path.join(directory, '.gitignore'), 'dist/\n');
  await fs.writeFile(path.join(directory, 'app.ts'), 'export {};\n');
  await git('add', '.');
  await git('commit', '-m', 'baseline');
});

afterEach(async () => {
  await fs.rm(directory, { recursive: true, force: true });
});

describe('probeWorkspaceCleanliness (real Git)', () => {
  it('reports nothing for a committed workspace with only gitignored output', async () => {
    await fs.mkdir(path.join(directory, 'dist'));
    await fs.writeFile(path.join(directory, 'dist', 'out.js'), '');
    expect(await probeWorkspaceCleanliness(local, { includeLocallyExcluded: true })).toEqual({
      untracked: [],
      changed: [],
      hiddenByLocalExclude: [],
    });
  });

  it('separates visible leftovers from paths hidden only by .git/info/exclude', async () => {
    await fs.writeFile(path.join(directory, 'app.ts'), 'export const changed = 1;\n');
    await fs.writeFile(path.join(directory, 'notes.md'), 'scratch\n');
    await fs.mkdir(path.join(directory, 'thoughts'));
    await fs.writeFile(path.join(directory, 'thoughts', 'plan.md'), 'scratch\n');
    await fs.mkdir(path.join(directory, '.autopod'));
    await fs.writeFile(path.join(directory, '.autopod', 'provider-failover.md'), 'handoff\n');
    await fs.appendFile(path.join(directory, '.git', 'info', 'exclude'), 'thoughts/\n.autopod/\n');
    expect(await probeWorkspaceCleanliness(local, { includeLocallyExcluded: true })).toEqual({
      untracked: ['notes.md'],
      changed: ['app.ts'],
      hiddenByLocalExclude: ['thoughts/'],
    });
    expect(
      (await probeWorkspaceCleanliness(local, { includeLocallyExcluded: false }))
        ?.hiddenByLocalExclude,
    ).toEqual([]);
  });

  it('returns null when Git state is unavailable', async () => {
    await fs.rm(path.join(directory, '.git'), { recursive: true, force: true });
    expect(await probeWorkspaceCleanliness(local, { includeLocallyExcluded: true })).toBeNull();
  });
});
