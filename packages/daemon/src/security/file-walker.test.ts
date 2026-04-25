import { execSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  globToRegex,
  listAlwaysScan,
  listDiffFiles,
  listTrackedFiles,
  loadScanFiles,
} from './file-walker.js';

describe('globToRegex', () => {
  it('matches a single segment with `*`', () => {
    const re = globToRegex('CLAUDE.md');
    expect(re.test('CLAUDE.md')).toBe(true);
    expect(re.test('a/CLAUDE.md')).toBe(false);
  });

  it('matches any depth with `**/`', () => {
    const re = globToRegex('**/CLAUDE.md');
    expect(re.test('CLAUDE.md')).toBe(true);
    expect(re.test('foo/CLAUDE.md')).toBe(true);
    expect(re.test('a/b/c/CLAUDE.md')).toBe(true);
    expect(re.test('a/CLAUDE.md.bak')).toBe(false);
  });

  it('respects the `*` segment boundary', () => {
    const re = globToRegex('.cursor/rules/**/*.md');
    expect(re.test('.cursor/rules/foo.md')).toBe(true);
    expect(re.test('.cursor/rules/sub/foo.md')).toBe(true);
    expect(re.test('.cursor/rules/foo.txt')).toBe(false);
  });

  it('escapes regex metacharacters in literal segments', () => {
    const re = globToRegex('.aider.conf.yml');
    expect(re.test('.aider.conf.yml')).toBe(true);
    expect(re.test('xaiderxconfxyml')).toBe(false);
  });
});

describe('file-walker against a real git repo', () => {
  let workdir: string;

  beforeEach(() => {
    workdir = mkdtempSync(path.join(os.tmpdir(), 'autopod-fw-'));
    execSync('git init -q', { cwd: workdir });
    execSync('git config user.email t@e.x', { cwd: workdir });
    execSync('git config user.name test', { cwd: workdir });
    execSync('git config commit.gpgsign false', { cwd: workdir });
    writeFileSync(path.join(workdir, 'README.md'), '# repo');
    writeFileSync(path.join(workdir, 'CLAUDE.md'), 'instructions');
    mkdirSync(path.join(workdir, 'src'));
    writeFileSync(path.join(workdir, 'src/a.ts'), 'export const x = 1;');
    mkdirSync(path.join(workdir, 'node_modules', 'lib'), { recursive: true });
    writeFileSync(path.join(workdir, 'node_modules/lib/index.js'), '/* skipped */');
    writeFileSync(path.join(workdir, '.gitignore'), 'node_modules/\n');
    execSync('git add -A', { cwd: workdir });
    execSync('git commit -q -m initial', { cwd: workdir });
  });

  afterEach(() => {
    rmSync(workdir, { recursive: true, force: true });
  });

  it('listTrackedFiles returns only tracked files', async () => {
    const files = await listTrackedFiles(workdir);
    expect(files).toEqual(expect.arrayContaining(['README.md', 'CLAUDE.md', 'src/a.ts']));
    expect(files).not.toContain('node_modules/lib/index.js');
  });

  it('listAlwaysScan matches the default-style globs', async () => {
    const matched = await listAlwaysScan(workdir, ['CLAUDE.md', '**/CLAUDE.md', 'README.md']);
    expect(matched).toEqual(expect.arrayContaining(['CLAUDE.md', 'README.md']));
  });

  it('listDiffFiles returns the changed paths against a base ref', async () => {
    execSync('git checkout -q -b feature', { cwd: workdir });
    writeFileSync(path.join(workdir, 'src/b.ts'), 'export const y = 2;');
    execSync('git add -A', { cwd: workdir });
    execSync('git commit -q -m feature', { cwd: workdir });
    const files = await listDiffFiles(workdir, 'master');
    // newer git defaults to "main" — accept either base ref name
    let resolved = files;
    if (resolved.length === 0) {
      resolved = await listDiffFiles(workdir, 'main').catch(() => [] as string[]);
    }
    expect(resolved).toContain('src/b.ts');
  });

  it('loadScanFiles skips files larger than the limit', async () => {
    const big = 'a'.repeat(2048);
    writeFileSync(path.join(workdir, 'big.txt'), big);
    const { files, skipped } = await loadScanFiles(workdir, ['big.txt'], { maxBytes: 1024 });
    expect(files).toHaveLength(0);
    expect(skipped).toBe(1);
  });

  it('loadScanFiles skips binary files', async () => {
    const buf = Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04, 0x00]);
    writeFileSync(path.join(workdir, 'blob.bin'), buf);
    const { files, skipped } = await loadScanFiles(workdir, ['blob.bin']);
    expect(files).toHaveLength(0);
    expect(skipped).toBe(1);
  });
});
