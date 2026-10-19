import { describe, expect, it } from 'vitest';
import { createWorkspaceFixture } from '../test-utils/workspace-recovery-helpers.js';
describe('workspace branch source ownership', () => {
  it('keeps standalone parent identity and refuses ownerless single-PR series', () => {
    const f = createWorkspaceFixture();
    const parent = f.pod();
    expect(f.branchSource().resolveBranchSource(parent)).toBe(parent);
    expect(() =>
      f.branchSource().resolveBranchSource({ ...parent, prMode: 'single', seriesId: null }),
    ).toThrow('no seriesId');
    expect(() =>
      f.branchSource().resolveBranchSource({ ...parent, prMode: 'single', seriesId: 'empty' }),
    ).toThrow('owns a PR');
  });
  it('selects the matching PR owner deterministically without moving parent state', () => {
    const f = createWorkspaceFixture();
    f.db
      .prepare('UPDATE pods SET series_id=?, pr_mode=?, pr_url=? WHERE id=?')
      .run('series', 'single', 'https://github.com/org/repo/pull/1', 'prepare');
    f.insertFix('validated');
    f.db
      .prepare('UPDATE pods SET series_id=?, pr_mode=?, pr_url=? WHERE id=?')
      .run('series', 'single', 'https://github.com/org/repo/pull/2', 'fix-child');
    const parent = { ...f.pod(), prUrl: 'https://github.com/org/repo/pull/2' };
    expect(f.branchSource().resolveBranchSource(parent).id).toBe('fix-child');
    expect(f.pod().prUrl).toBe('https://github.com/org/repo/pull/1');
  });
});
