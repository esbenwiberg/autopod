import { describe, expect, it } from 'vitest';
import { buildValidationContextEnv } from './validation-context-env.js';

describe('buildValidationContextEnv', () => {
  it('uses the pod start commit as the diff-scoped validation base when available', () => {
    expect(
      buildValidationContextEnv({
        podId: 'pod-123',
        headBranch: 'autopod/child',
        baseBranch: 'main',
        startCommitSha: 'abc123',
      }),
    ).toEqual({
      AUTOPOD_POD_ID: 'pod-123',
      AUTOPOD_HEAD_BRANCH: 'autopod/child',
      AUTOPOD_BASE_BRANCH: 'main',
      AUTOPOD_PR_BASE_REF: 'origin/main',
      AUTOPOD_VALIDATION_BASE_REF: 'abc123',
      AUTOPOD_START_COMMIT_SHA: 'abc123',
    });
  });

  it('falls back to the PR base ref when no start commit is available', () => {
    expect(
      buildValidationContextEnv({
        podId: 'pod-123',
        headBranch: 'autopod/root',
        baseBranch: 'release/1.2',
        startCommitSha: null,
      }),
    ).toEqual({
      AUTOPOD_POD_ID: 'pod-123',
      AUTOPOD_HEAD_BRANCH: 'autopod/root',
      AUTOPOD_BASE_BRANCH: 'release/1.2',
      AUTOPOD_PR_BASE_REF: 'origin/release/1.2',
      AUTOPOD_VALIDATION_BASE_REF: 'origin/release/1.2',
    });
  });

  it('does not double-prefix explicit refs', () => {
    expect(
      buildValidationContextEnv({
        podId: 'pod-123',
        headBranch: 'autopod/root',
        baseBranch: 'origin/main',
      }).AUTOPOD_PR_BASE_REF,
    ).toBe('origin/main');

    expect(
      buildValidationContextEnv({
        podId: 'pod-123',
        headBranch: 'autopod/root',
        baseBranch: 'refs/heads/main',
      }).AUTOPOD_PR_BASE_REF,
    ).toBe('refs/heads/main');
  });
});
