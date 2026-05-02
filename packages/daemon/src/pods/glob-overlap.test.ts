import { describe, expect, it } from 'vitest';
import { findGlobOverlaps, globPrefix, pathsOverlap } from './glob-overlap.js';

describe('globPrefix', () => {
  it('returns the full path when no glob chars are present', () => {
    expect(globPrefix('packages/daemon/src/pod-manager.ts')).toBe(
      'packages/daemon/src/pod-manager.ts',
    );
  });

  it('cuts at the first glob char', () => {
    expect(globPrefix('packages/daemon/src/**')).toBe('packages/daemon/src');
    expect(globPrefix('packages/daemon/*.ts')).toBe('packages/daemon');
    expect(globPrefix('packages/daemon/?.ts')).toBe('packages/daemon');
    expect(globPrefix('packages/{a,b}/foo')).toBe('packages');
  });

  it('cuts back to the last full segment for mid-segment globs', () => {
    expect(globPrefix('src/foo*.ts')).toBe('src');
    expect(globPrefix('a/b/c-*.ts')).toBe('a/b');
  });

  it('strips trailing slashes', () => {
    expect(globPrefix('packages/daemon/')).toBe('packages/daemon');
  });

  it('returns empty for top-level wildcards', () => {
    expect(globPrefix('**')).toBe('');
    expect(globPrefix('*.ts')).toBe('');
  });

  it('handles empty input', () => {
    expect(globPrefix('')).toBe('');
    expect(globPrefix('   ')).toBe('');
  });
});

describe('pathsOverlap', () => {
  it('returns true for identical paths', () => {
    expect(pathsOverlap('packages/daemon', 'packages/daemon')).toBe(true);
  });

  it('returns true when one is a path-segment prefix of the other', () => {
    expect(pathsOverlap('packages/daemon', 'packages/daemon/src/x.ts')).toBe(true);
    expect(pathsOverlap('packages/daemon/src/x.ts', 'packages/daemon')).toBe(true);
  });

  it('refuses partial-segment matches', () => {
    expect(pathsOverlap('packages/daemon', 'packages/daemon-tools')).toBe(false);
    expect(pathsOverlap('packages/daemon-tools', 'packages/daemon')).toBe(false);
  });

  it('returns false for disjoint paths', () => {
    expect(pathsOverlap('packages/daemon', 'packages/cli')).toBe(false);
  });

  it('returns true when either prefix is empty (matches everything)', () => {
    expect(pathsOverlap('', 'packages/daemon')).toBe(true);
    expect(pathsOverlap('packages/daemon', '')).toBe(true);
  });
});

describe('findGlobOverlaps', () => {
  it('finds a clear directory overlap', () => {
    const matches = findGlobOverlaps(
      ['packages/daemon/src/pods/**'],
      ['packages/daemon/src/pods/pod-manager.ts'],
    );
    expect(matches).toHaveLength(1);
    expect(matches[0]).toEqual({
      ours: 'packages/daemon/src/pods/**',
      theirs: 'packages/daemon/src/pods/pod-manager.ts',
    });
  });

  it('returns empty for disjoint scopes', () => {
    const matches = findGlobOverlaps(['packages/daemon/**'], ['packages/cli/**']);
    expect(matches).toEqual([]);
  });

  it('returns multiple matches when several globs cross', () => {
    const matches = findGlobOverlaps(
      ['packages/daemon/src/pods/**', 'packages/shared/**'],
      ['packages/daemon/src/pods/pod-manager.ts', 'packages/shared/src/types/pod.ts'],
    );
    expect(matches).toHaveLength(2);
  });

  it('does not match similar but distinct directory names', () => {
    const matches = findGlobOverlaps(['packages/daemon/**'], ['packages/daemon-tools/**']);
    expect(matches).toEqual([]);
  });

  it('handles empty inputs', () => {
    expect(findGlobOverlaps([], ['packages/daemon/**'])).toEqual([]);
    expect(findGlobOverlaps(['packages/daemon/**'], [])).toEqual([]);
  });
});
