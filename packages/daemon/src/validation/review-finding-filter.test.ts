import { describe, expect, it, vi } from 'vitest';
import {
  type ParsedReviewLike,
  applyDiffFilterToParsed,
  filterOutOfDiffFindings,
} from './review-finding-filter.js';

const DIFF_TWO_FILES = [
  'diff --git a/Client/package-lock.json b/Client/package-lock.json',
  '--- a/Client/package-lock.json',
  '+++ b/Client/package-lock.json',
  '@@ -1 +1 @@',
  '-old',
  '+new',
  'diff --git a/.changes/npm-uuid.security.md b/.changes/npm-uuid.security.md',
  '--- /dev/null',
  '+++ b/.changes/npm-uuid.security.md',
  '@@ -0,0 +1,1 @@',
  '+report',
].join('\n');

describe('filterOutOfDiffFindings', () => {
  it('returns empty list unchanged', () => {
    expect(filterOutOfDiffFindings([], DIFF_TWO_FILES)).toEqual({
      issues: [],
      droppedCount: 0,
      droppedExamples: [],
    });
  });

  it('keeps everything when diff has no file headers', () => {
    const issues = ['[HIGH] Frameworks/PF.Graph/GraphRequests.cs:26 something'];
    const result = filterOutOfDiffFindings(issues, '');
    expect(result.issues).toEqual(issues);
    expect(result.droppedCount).toBe(0);
  });

  it('keeps everything when diff is truncated', () => {
    const truncatedDiff = `${DIFF_TWO_FILES}\n⚠ DIFF TRUNCATED: too large`;
    const issues = ['[HIGH] some/other/file.ts:10 unrelated'];
    const result = filterOutOfDiffFindings(issues, truncatedDiff);
    expect(result.issues).toEqual(issues);
    expect(result.droppedCount).toBe(0);
  });

  it('drops findings citing only out-of-diff paths', () => {
    const issues = [
      '[HIGH] Frameworks/PF.Graph/GraphRequests.cs (~line 110): captures void Task',
      '[MEDIUM] Frameworks/PF.Graph/GraphClient.cs:34 socket exhaustion',
    ];
    const result = filterOutOfDiffFindings(issues, DIFF_TWO_FILES);
    expect(result.issues).toEqual([]);
    expect(result.droppedCount).toBe(2);
    expect(result.droppedExamples).toHaveLength(2);
  });

  it('keeps findings that cite an in-diff path by full path', () => {
    const issues = [
      '[MEDIUM] Client/package-lock.json: SHA-1 integrity downgrade weakens supply chain',
    ];
    const result = filterOutOfDiffFindings(issues, DIFF_TWO_FILES);
    expect(result.issues).toEqual(issues);
    expect(result.droppedCount).toBe(0);
  });

  it('drops daemon tooling cache findings even when the cache path appears in the diff', () => {
    const diff = [
      'diff --git a/.serena/project.yml b/.serena/project.yml',
      '--- a/.serena/project.yml',
      '+++ b/.serena/project.yml',
      '@@ -1 +0,0 @@',
      '-generated cache',
    ].join('\n');
    const issues = [
      '[CRITICAL] Agent committed changes to `.serena/project.yml` despite read-only audit instructions',
    ];

    const result = filterOutOfDiffFindings(issues, diff);

    expect(result.issues).toEqual([]);
    expect(result.droppedCount).toBe(1);
  });

  it('keeps mixed findings that cite a real diff path alongside daemon tooling cache paths', () => {
    const diff = [
      'diff --git a/src/index.ts b/src/index.ts',
      '--- a/src/index.ts',
      '+++ b/src/index.ts',
      '@@ -1 +1 @@',
      '-old',
      '+new',
      'diff --git a/.serena/project.yml b/.serena/project.yml',
      '--- a/.serena/project.yml',
      '+++ b/.serena/project.yml',
      '@@ -1 +0,0 @@',
      '-generated cache',
    ].join('\n');
    const issues = [
      '[HIGH] src/index.ts and .serena/project.yml reveal the generated route is broken',
    ];

    const result = filterOutOfDiffFindings(issues, diff);

    expect(result.issues).toEqual(issues);
    expect(result.droppedCount).toBe(0);
  });

  it('keeps findings that cite an in-diff path by basename only', () => {
    const issues = ['[MEDIUM] package-lock.json: SHA-1 integrity downgrade'];
    const result = filterOutOfDiffFindings(issues, DIFF_TWO_FILES);
    expect(result.issues).toEqual(issues);
  });

  it('keeps findings that mix in-diff and out-of-diff paths', () => {
    const issues = ['[HIGH] package-lock.json + Frameworks/PF.Graph/GraphClient.cs both affected'];
    const result = filterOutOfDiffFindings(issues, DIFF_TWO_FILES);
    expect(result.issues).toEqual(issues);
  });

  it('keeps findings that cite no file path at all', () => {
    const issues = [
      '[MEDIUM] missing test coverage for the new error path',
      '[HIGH] secret committed in plaintext',
    ];
    const result = filterOutOfDiffFindings(issues, DIFF_TWO_FILES);
    expect(result.issues).toEqual(issues);
  });

  it('does not treat version numbers like 14.0.0 as paths', () => {
    const issues = ['[MEDIUM] Bump uuid to 14.0.0 to fix CWE-787'];
    const result = filterOutOfDiffFindings(issues, DIFF_TWO_FILES);
    expect(result.issues).toEqual(issues);
  });

  it('does not treat URL hosts like github.com as code paths', () => {
    const issues = ['[MEDIUM] external dep pinned to https://github.com/foo/bar release'];
    const result = filterOutOfDiffFindings(issues, DIFF_TWO_FILES);
    expect(result.issues).toEqual(issues);
  });

  it('handles multi-extension filenames like foo.test.ts', () => {
    const diff = [
      'diff --git a/src/foo.test.ts b/src/foo.test.ts',
      '--- a/src/foo.test.ts',
      '+++ b/src/foo.test.ts',
      '@@ -1 +1 @@',
      '-old',
      '+new',
    ].join('\n');
    const issues = ['[MEDIUM] src/foo.test.ts asserts the wrong shape'];
    const result = filterOutOfDiffFindings(issues, diff);
    expect(result.issues).toEqual(issues);
  });

  it('handles dotted directory names like PF.Graph', () => {
    const diff = [
      'diff --git a/Frameworks/PF.Graph/GraphRequests.cs b/Frameworks/PF.Graph/GraphRequests.cs',
      '--- a/Frameworks/PF.Graph/GraphRequests.cs',
      '+++ b/Frameworks/PF.Graph/GraphRequests.cs',
      '@@ -1 +1 @@',
      '-old',
      '+new',
    ].join('\n');
    const issues = ['[HIGH] Frameworks/PF.Graph/GraphRequests.cs:110 captures void Task'];
    const result = filterOutOfDiffFindings(issues, diff);
    expect(result.issues).toEqual(issues);
  });

  it('strips trailing punctuation when matching paths', () => {
    const issues = ['[MEDIUM] in `package-lock.json`, the integrity hash downgraded.'];
    const result = filterOutOfDiffFindings(issues, DIFF_TWO_FILES);
    expect(result.issues).toEqual(issues);
  });
});

describe('applyDiffFilterToParsed', () => {
  const baseLog = { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() };

  function freshLog() {
    return { ...baseLog, warn: vi.fn() };
  }

  it('returns null when parsed is null', () => {
    expect(applyDiffFilterToParsed(null, DIFF_TWO_FILES, undefined, 1)).toBeNull();
  });

  it('returns input unchanged when nothing is dropped', () => {
    const parsed: ParsedReviewLike = {
      status: 'pass',
      reasoning: 'all good',
      issues: ['[MEDIUM] missing test for new branch'],
    };
    const log = freshLog();
    // biome-ignore lint/suspicious/noExplicitAny: test logger shim
    const result = applyDiffFilterToParsed(parsed, DIFF_TWO_FILES, log as any, 1);
    expect(result).toBe(parsed);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('drops out-of-diff issues and logs', () => {
    const parsed: ParsedReviewLike = {
      status: 'fail',
      reasoning: 'agent missed C# issues',
      issues: [
        '[HIGH] Frameworks/PF.Graph/GraphRequests.cs:110 broken',
        '[MEDIUM] package-lock.json SHA-1 downgrade',
      ],
    };
    const log = freshLog();
    // biome-ignore lint/suspicious/noExplicitAny: test logger shim
    const result = applyDiffFilterToParsed(parsed, DIFF_TWO_FILES, log as any, 3);
    expect(result?.issues).toEqual(['[MEDIUM] package-lock.json SHA-1 downgrade']);
    expect(result?.status).toBe('fail');
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ tier: 3, droppedCount: 1 }),
      expect.any(String),
    );
  });

  it('flips fail→pass when filtering removes every reason to fail', () => {
    const parsed: ParsedReviewLike = {
      status: 'fail',
      reasoning: 'agent missed C# issues',
      issues: [
        '[HIGH] Frameworks/PF.Graph/GraphRequests.cs:110 broken',
        '[MEDIUM] Frameworks/PF.Graph/GraphClient.cs:34 socket exhaustion',
      ],
    };
    const log = freshLog();
    // biome-ignore lint/suspicious/noExplicitAny: test logger shim
    const result = applyDiffFilterToParsed(parsed, DIFF_TWO_FILES, log as any, 3);
    expect(result?.issues).toEqual([]);
    expect(result?.status).toBe('pass');
    expect(result?.reasoning).toContain('auto-pass');
  });

  it('does NOT flip when an unmet requirement is the real fail reason', () => {
    const parsed: ParsedReviewLike = {
      status: 'fail',
      reasoning: 'AC not met',
      issues: ['[HIGH] Frameworks/PF.Graph/GraphRequests.cs:110 broken'],
      requirementsCheck: [{ criterion: 'must do X', met: false, note: 'absent in diff' }],
    };
    const log = freshLog();
    // biome-ignore lint/suspicious/noExplicitAny: test logger shim
    const result = applyDiffFilterToParsed(parsed, DIFF_TWO_FILES, log as any, 3);
    expect(result?.issues).toEqual([]);
    expect(result?.status).toBe('fail');
  });

  it('does NOT flip when there are undisclosed deviations', () => {
    const parsed: ParsedReviewLike = {
      status: 'fail',
      reasoning: 'undisclosed scope',
      issues: ['[HIGH] Frameworks/PF.Graph/GraphRequests.cs:110 broken'],
      deviationsAssessment: {
        disclosedDeviations: [],
        undisclosedDeviations: ['agent silently rewrote auth flow'],
      },
    };
    const log = freshLog();
    // biome-ignore lint/suspicious/noExplicitAny: test logger shim
    const result = applyDiffFilterToParsed(parsed, DIFF_TWO_FILES, log as any, 3);
    expect(result?.issues).toEqual([]);
    expect(result?.status).toBe('fail');
  });
});
