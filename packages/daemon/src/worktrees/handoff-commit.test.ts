import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import { expect, it } from 'vitest';
import { LocalWorktreeManager } from './local-worktree-manager.js';

it('commits exact handoff paths, retains unrelated staged work and never runs repository hooks', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'autopod-handoff-commit-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' });
  try {
    git('init', '--quiet');
    git('config', 'user.name', 'Fixture');
    git('config', 'user.email', 'fixture@example.invalid');
    writeFileSync(join(cwd, 'initial'), 'initial');
    git('add', 'initial');
    git('-c', 'core.hooksPath=/dev/null', 'commit', '--quiet', '-m', 'Initial');
    writeFileSync(join(cwd, 'unrelated.ts'), 'keep staged');
    git('add', 'unrelated.ts');
    const handoff = ['brief.md', 'contract.yaml', 'space and\nnewline.md', '--option.md'];
    for (const file of handoff) writeFileSync(join(cwd, file), 'handoff');
    const hook = join(cwd, '.git/hooks/pre-commit');
    writeFileSync(hook, '#!/bin/sh\nexit 71\n');
    chmodSync(hook, 0o700);
    const manager = new LocalWorktreeManager({ logger: pino({ level: 'silent' }) });
    await manager.commitFiles(cwd, handoff, 'Handoff');
    expect(git('log', '-1', '--format=%s').trim()).toBe('Handoff');
    expect(
      git('diff-tree', '--no-commit-id', '--name-only', '-r', '-z', 'HEAD')
        .split('\0')
        .filter(Boolean)
        .sort(),
    ).toEqual([...handoff].sort());
    expect(git('diff', '--cached', '--name-only').trim()).toBe('unrelated.ts');
    expect(readFileSync(join(cwd, 'unrelated.ts'), 'utf8')).toBe('keep staged');
    await expect(manager.commitFiles(cwd, ['missing.md'], 'Invalid')).rejects.toThrow();
    expect(git('log', '-1', '--format=%s').trim()).toBe('Handoff');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
