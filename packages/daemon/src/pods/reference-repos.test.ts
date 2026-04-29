import type { Profile, ReferenceRepo } from '@autopod/shared';
import { describe, expect, it, vi } from 'vitest';
import { deriveReferenceRepos, resolveRefRepoPat } from './reference-repos.js';

describe('deriveReferenceRepos', () => {
  it('returns empty array for nullish or empty input', () => {
    expect(deriveReferenceRepos(undefined)).toEqual([]);
    expect(deriveReferenceRepos(null)).toEqual([]);
    expect(deriveReferenceRepos([])).toEqual([]);
  });

  it('derives mountPath from the last URL segment, stripping .git', () => {
    expect(
      deriveReferenceRepos([
        { url: 'https://github.com/org/docs-gen.git' },
        { url: 'https://github.com/org/pipelines' },
      ]),
    ).toEqual([
      { url: 'https://github.com/org/docs-gen.git', mountPath: 'docs-gen' },
      { url: 'https://github.com/org/pipelines', mountPath: 'pipelines' },
    ]);
  });

  it('disambiguates colliding mount paths within a single pod', () => {
    expect(
      deriveReferenceRepos([
        { url: 'https://github.com/org-a/utils' },
        { url: 'https://github.com/org-b/utils.git' },
        { url: 'https://github.com/org-c/utils' },
      ]),
    ).toEqual([
      { url: 'https://github.com/org-a/utils', mountPath: 'utils' },
      { url: 'https://github.com/org-b/utils.git', mountPath: 'utils-2' },
      { url: 'https://github.com/org-c/utils', mountPath: 'utils-3' },
    ]);
  });

  it('falls back to the full URL when the last segment is empty', () => {
    expect(deriveReferenceRepos([{ url: 'https://github.com/org/repo/' }])).toEqual([
      { url: 'https://github.com/org/repo/', mountPath: 'repo' },
    ]);
  });

  it('preserves order of input', () => {
    const result = deriveReferenceRepos([
      { url: 'https://example/a' },
      { url: 'https://example/b' },
      { url: 'https://example/a' },
    ]);
    expect(result.map((r) => r.url)).toEqual([
      'https://example/a',
      'https://example/b',
      'https://example/a',
    ]);
    expect(result.map((r) => r.mountPath)).toEqual(['a', 'b', 'a-2']);
  });

  it('propagates sourceProfile on each entry, omitting it when absent', () => {
    const result = deriveReferenceRepos([
      { url: 'https://github.com/org/a', sourceProfile: 'duck' },
      { url: 'https://github.com/org/b' },
    ]);
    expect(result).toEqual([
      { url: 'https://github.com/org/a', mountPath: 'a', sourceProfile: 'duck' },
      { url: 'https://github.com/org/b', mountPath: 'b' },
    ]);
  });

  it('disambiguates colliding mount paths even when sourceProfile differs', () => {
    const result = deriveReferenceRepos([
      { url: 'https://github.com/org-a/utils', sourceProfile: 'duck' },
      { url: 'https://github.com/org-b/utils', sourceProfile: 'goose' },
    ]);
    expect(result.map((r) => r.mountPath)).toEqual(['utils', 'utils-2']);
    expect(result.map((r) => r.sourceProfile)).toEqual(['duck', 'goose']);
  });
});

function makeProfile(overrides: Partial<Profile>): Profile {
  return {
    name: 'duck',
    repoUrl: 'https://github.com/esbenwiberg/duck',
    githubPat: null,
    adoPat: null,
    prProvider: null,
    ...overrides,
  } as Profile;
}

describe('resolveRefRepoPat', () => {
  const repoBase: ReferenceRepo = {
    url: 'https://github.com/org/repo',
    mountPath: 'repo',
  };

  it('returns undefined when sourceProfile is unset', () => {
    const store = { get: vi.fn() };
    expect(resolveRefRepoPat(repoBase, store)).toBeUndefined();
    expect(store.get).not.toHaveBeenCalled();
  });

  it('returns the github PAT for a github URL when prProvider=github', () => {
    const profile = makeProfile({ githubPat: 'gh_token', prProvider: 'github' });
    const store = { get: vi.fn().mockReturnValue(profile) };
    const repo = { ...repoBase, sourceProfile: 'duck' };
    expect(resolveRefRepoPat(repo, store)).toBe('gh_token');
  });

  it('returns the ADO PAT when prProvider=ado', () => {
    const profile = makeProfile({
      adoPat: 'ado_token',
      githubPat: 'should_not_be_used',
      prProvider: 'ado',
    });
    const store = { get: vi.fn().mockReturnValue(profile) };
    const repo = { ...repoBase, sourceProfile: 'duck' };
    expect(resolveRefRepoPat(repo, store)).toBe('ado_token');
  });

  it('warns and returns undefined when the source profile is missing', () => {
    const store = { get: vi.fn().mockReturnValue(undefined) };
    const logger = { warn: vi.fn() };
    const repo = { ...repoBase, sourceProfile: 'ghost' };
    expect(resolveRefRepoPat(repo, store, logger)).toBeUndefined();
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it('returns undefined when the resolved PAT field is empty', () => {
    const profile = makeProfile({ githubPat: null, prProvider: 'github' });
    const store = { get: vi.fn().mockReturnValue(profile) };
    const repo = { ...repoBase, sourceProfile: 'duck' };
    expect(resolveRefRepoPat(repo, store)).toBeUndefined();
  });
});
