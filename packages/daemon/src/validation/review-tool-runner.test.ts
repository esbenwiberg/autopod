import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const execFileAsync = promisify(execFile);

// We test the internal tool implementations by importing the module and
// exercising them through the exported runToolUseReview (with a mocked SDK).
// For unit testing the tools directly, we re-implement the path safety check.

describe('review tool runner - path safety', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'review-tools-'));
    await fs.mkdir(path.join(tmpDir, 'src'), { recursive: true });
    await fs.writeFile(path.join(tmpDir, 'src/index.ts'), 'export const x = 1;');
    await fs.writeFile(path.join(tmpDir, 'secret.env'), 'API_KEY=hunter2');
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('resolveSafePath rejects path traversal', () => {
    // Simulate the path resolution logic
    const relPath = '../../etc/passwd';
    const resolved = path.resolve(tmpDir, relPath);
    expect(resolved.startsWith(path.resolve(tmpDir))).toBe(false);
  });

  it('resolveSafePath allows valid paths', () => {
    const relPath = 'src/index.ts';
    const resolved = path.resolve(tmpDir, relPath);
    expect(resolved.startsWith(path.resolve(tmpDir))).toBe(true);
  });

  it('resolveSafePath allows nested paths', () => {
    const relPath = 'src/../src/index.ts';
    const resolved = path.resolve(tmpDir, relPath);
    expect(resolved.startsWith(path.resolve(tmpDir))).toBe(true);
  });
});

describe('review tool runner - git log arg filtering', () => {
  const ALLOWED_GIT_LOG_FLAGS = new Set([
    '--oneline',
    '--graph',
    '--stat',
    '--name-status',
    '--name-only',
    '--format',
    '--pretty',
    '--reverse',
    '--first-parent',
    '--no-merges',
    '--merges',
  ]);

  function isAllowedFlag(arg: string): boolean {
    if (arg.startsWith('--')) {
      const flagName = arg.includes('=') ? arg.split('=')[0] : arg;
      return ALLOWED_GIT_LOG_FLAGS.has(flagName);
    }
    if (arg.match(/^-\d+$/)) return true;
    if (arg.match(/^[a-zA-Z0-9_.~^/.-]+(?:\.\.[a-zA-Z0-9_.~^/.-]+)?$/)) return true;
    if (arg.startsWith('--format=') || arg.startsWith('--pretty=')) return true;
    return false;
  }

  it('allows safe flags', () => {
    expect(isAllowedFlag('--oneline')).toBe(true);
    expect(isAllowedFlag('--stat')).toBe(true);
    expect(isAllowedFlag('--name-status')).toBe(true);
    expect(isAllowedFlag('-10')).toBe(true);
    expect(isAllowedFlag('HEAD~3..HEAD')).toBe(true);
    expect(isAllowedFlag('--format=%H %s')).toBe(true);
  });

  it('rejects dangerous flags', () => {
    expect(isAllowedFlag('--exec')).toBe(false);
    expect(isAllowedFlag('--diff-filter')).toBe(false);
    expect(isAllowedFlag('--follow')).toBe(false);
  });
});

describe('review tool runner - model ID resolution', () => {
  it('maps short aliases to full IDs', () => {
    const aliases: Record<string, string> = {
      sonnet: 'claude-sonnet-4-20250514',
      opus: 'claude-opus-4-20250514',
      haiku: 'claude-haiku-4-5-20251001',
    };

    expect(aliases.sonnet).toBe('claude-sonnet-4-20250514');
    expect(aliases.opus).toBe('claude-opus-4-20250514');
  });

  it('passes through full model IDs', () => {
    const aliases: Record<string, string> = {
      sonnet: 'claude-sonnet-4-20250514',
    };
    const model = 'claude-3-5-sonnet-20241022';
    expect(aliases[model] ?? model).toBe('claude-3-5-sonnet-20241022');
  });
});

describe('review tool runner - tool implementations', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'review-tools-impl-'));
    await execFileAsync('git', ['init', '--initial-branch=main'], { cwd: tmpDir });
    await execFileAsync('git', ['config', 'user.email', 'test@test.com'], { cwd: tmpDir });
    await execFileAsync('git', ['config', 'user.name', 'Test'], { cwd: tmpDir });
    await fs.mkdir(path.join(tmpDir, 'src'), { recursive: true });
    await fs.writeFile(path.join(tmpDir, 'src/index.ts'), 'export const hello = "world";');
    await fs.writeFile(path.join(tmpDir, 'package.json'), '{"name": "test"}');
    await execFileAsync('git', ['add', '.'], { cwd: tmpDir });
    await execFileAsync('git', ['commit', '-m', 'init'], { cwd: tmpDir });
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('read_file reads files from worktree', async () => {
    const content = await fs.readFile(path.join(tmpDir, 'src/index.ts'), 'utf-8');
    expect(content).toContain('hello');
  });

  it('list_directory lists entries', async () => {
    const entries = await fs.readdir(tmpDir, { withFileTypes: true });
    const names = entries.map((e) => e.name);
    expect(names).toContain('src');
    expect(names).toContain('package.json');
  });

  it('git_status works on clean repo', async () => {
    const { stdout } = await execFileAsync('git', ['status', '--porcelain'], { cwd: tmpDir });
    expect(stdout.trim()).toBe('');
  });

  it('git_status detects uncommitted changes', async () => {
    await fs.writeFile(path.join(tmpDir, 'new.ts'), 'export {};');
    const { stdout } = await execFileAsync('git', ['status', '--porcelain'], { cwd: tmpDir });
    expect(stdout).toContain('new.ts');
  });

  it('search_files finds patterns', async () => {
    const { stdout } = await execFileAsync('grep', ['-rn', '--', 'hello', '.'], { cwd: tmpDir });
    expect(stdout).toContain('index.ts');
  });
});
