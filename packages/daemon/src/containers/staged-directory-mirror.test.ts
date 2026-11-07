import {
  chmodSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { mirrorStagedDirectory } from './staged-directory-mirror.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'staged-mirror-'));
  roots.push(root);
  const source = path.join(root, 'source'),
    target = path.join(root, 'target'),
    outside = path.join(root, 'outside');
  for (const directory of [source, target, outside]) mkdirSync(directory);
  return { source, target, outside };
}

describe('staged directory mirror type and alias preservation', () => {
  it('replaces a preexisting skills directory with the exact directory symlink, including on repeated import', () => {
    const { source, target } = fixture();
    mkdirSync(path.join(source, '.agents/skills/example'), { recursive: true });
    writeFileSync(path.join(source, '.agents/skills/example/SKILL.md'), 'pinned skill');
    mkdirSync(path.join(source, '.claude'));
    symlinkSync('../.agents/skills', path.join(source, '.claude/skills'));
    mkdirSync(path.join(target, '.claude/skills'), { recursive: true });
    writeFileSync(path.join(target, '.claude/skills/stale.txt'), 'old generated directory');
    for (let n = 0; n < 2; n++) {
      mirrorStagedDirectory(source, target);
      expect(lstatSync(path.join(target, '.claude/skills')).isSymbolicLink()).toBe(true);
      expect(readlinkSync(path.join(target, '.claude/skills'))).toBe('../.agents/skills');
      expect(readFileSync(path.join(target, '.claude/skills/example/SKILL.md'), 'utf8')).toBe(
        'pinned skill',
      );
      expect(lstatSync(path.join(source, '.claude/skills')).isSymbolicLink()).toBe(true);
    }
  });

  it('replaces an old destination directory symlink without touching its outside target', () => {
    const { source, target, outside } = fixture();
    mkdirSync(path.join(source, 'dir'));
    writeFileSync(path.join(source, 'dir/fresh.txt'), 'selected source');
    writeFileSync(path.join(outside, 'keep.txt'), 'unrelated');
    symlinkSync(outside, path.join(target, 'dir'));
    mirrorStagedDirectory(source, target);
    expect(lstatSync(path.join(target, 'dir')).isDirectory()).toBe(true);
    expect(readFileSync(path.join(target, 'dir/fresh.txt'), 'utf8')).toBe('selected source');
    expect(readFileSync(path.join(outside, 'keep.txt'), 'utf8')).toBe('unrelated');
    expect(() => lstatSync(path.join(outside, 'fresh.txt'))).toThrow();
  });

  it('preserves executable and read-only directory modes while leaving excluded Git and nested caches intact', () => {
    const { source, target } = fixture();
    for (const root of [source, target]) {
      mkdirSync(path.join(root, '.git'));
      mkdirSync(path.join(root, 'app/node_modules'), { recursive: true });
    }
    writeFileSync(path.join(source, '.git/HEAD'), 'do not import');
    writeFileSync(path.join(target, '.git/HEAD'), 'canonical gitlink');
    writeFileSync(path.join(source, 'app/node_modules/cache'), 'do not import');
    writeFileSync(path.join(target, 'app/node_modules/cache'), 'keep cache');
    writeFileSync(path.join(source, 'app/check.sh'), 'exit 0\n');
    chmodSync(path.join(source, 'app/check.sh'), 0o751);
    chmodSync(path.join(source, 'app'), 0o550);
    writeFileSync(path.join(target, 'stale.txt'), 'remove');
    writeFileSync(path.join(target, 'app/stale.txt'), 'remove before restoring read-only mode');
    mirrorStagedDirectory(source, target, ['.git', 'node_modules']);
    expect(lstatSync(path.join(target, 'app/check.sh')).mode & 0o777).toBe(0o751);
    expect(lstatSync(path.join(target, 'app')).mode & 0o777).toBe(0o550);
    expect(readFileSync(path.join(target, '.git/HEAD'), 'utf8')).toBe('canonical gitlink');
    expect(readFileSync(path.join(target, 'app/node_modules/cache'), 'utf8')).toBe('keep cache');
    expect(() => lstatSync(path.join(target, 'stale.txt'))).toThrow();
    expect(() => lstatSync(path.join(target, 'app/stale.txt'))).toThrow();
    // Allow test-owned cleanup of the deliberately read-only source/target dirs.
    chmodSync(path.join(source, 'app'), 0o750);
    chmodSync(path.join(target, 'app'), 0o750);
  });

  it('refuses a type replacement that would delete an excluded nested cache', () => {
    const { source, target } = fixture();
    writeFileSync(path.join(source, 'app'), 'now a file');
    mkdirSync(path.join(target, 'app/node_modules'), { recursive: true });
    writeFileSync(path.join(target, 'app/node_modules/keep.txt'), 'cached');
    expect(() => mirrorStagedDirectory(source, target, ['node_modules'])).toThrow('excluded');
    expect(readFileSync(path.join(target, 'app/node_modules/keep.txt'), 'utf8')).toBe('cached');
  });

  it('prunes stale source files without deleting an excluded cache in their missing parent', () => {
    const { source, target } = fixture();
    mkdirSync(path.join(target, 'app/node_modules'), { recursive: true });
    writeFileSync(path.join(target, 'app/node_modules/keep.txt'), 'cached');
    writeFileSync(path.join(target, 'app/stale.txt'), 'old source');
    mirrorStagedDirectory(source, target, ['node_modules']);
    expect(readFileSync(path.join(target, 'app/node_modules/keep.txt'), 'utf8')).toBe('cached');
    expect(() => lstatSync(path.join(target, 'app/stale.txt'))).toThrow();
  });

  it('replaces a file hardlink without changing an unrelated alias', () => {
    const { source, target, outside } = fixture();
    writeFileSync(path.join(source, 'file.txt'), 'new');
    writeFileSync(path.join(outside, 'file.txt'), 'old');
    linkSync(path.join(outside, 'file.txt'), path.join(target, 'file.txt'));
    mirrorStagedDirectory(source, target);
    expect(readFileSync(path.join(target, 'file.txt'), 'utf8')).toBe('new');
    expect(readFileSync(path.join(outside, 'file.txt'), 'utf8')).toBe('old');
  });
});
