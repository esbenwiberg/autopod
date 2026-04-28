import { describe, expect, it } from 'vitest';
import { deriveReferenceRepos } from './reference-repos.js';

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
});
