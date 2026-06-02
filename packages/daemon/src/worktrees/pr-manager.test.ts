import type { Profile } from '@autopod/shared';
import pino from 'pino';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GhPrManager, GitHubApiPrManager } from './pr-manager.js';

// Track call count so we can return different responses for sequential calls
let callCount = 0;
const execResponses: Array<{ stdout: string; stderr: string }> = [];
const execCalls: unknown[][] = [];

vi.mock('node:util', async () => {
  const actual = await vi.importActual<typeof import('node:util')>('node:util');
  return {
    ...actual,
    promisify: vi.fn(() => {
      return async (...args: unknown[]) => {
        execCalls.push(args);
        const response = execResponses[callCount] ?? { stdout: '', stderr: '' };
        callCount++;
        return response;
      };
    }),
  };
});

const logger = pino({ level: 'silent' });

describe('GhPrManager', () => {
  beforeEach(() => {
    callCount = 0;
    execResponses.length = 0;
    execCalls.length = 0;
  });

  it('can be instantiated', () => {
    const manager = new GhPrManager({ logger });
    expect(manager).toBeDefined();
  });

  it('createPr returns trimmed PR URL with fallback metadata', async () => {
    execResponses.push({ stdout: 'https://github.com/org/repo/pull/42\n', stderr: '' });
    const manager = new GhPrManager({ logger });

    const result = await manager.createPr({
      worktreePath: '/tmp/worktree',
      branch: 'autopod/abc123',
      baseBranch: 'main',
      podId: 'abc123',
      task: 'Add dark mode',
      profileName: 'my-app',
      profile: { name: 'my-app' } as unknown as Profile,
      podModel: 'haiku',
      validationResult: null,
      filesChanged: 3,
      linesAdded: 50,
      linesRemoved: 10,
      previewUrl: null,
    });

    expect(result.url).toBe('https://github.com/org/repo/pull/42');
    // Profile has no modelProvider here, which falls through to env-var anthropic;
    // since ANTHROPIC_API_KEY is not set in tests, the LLM client returns null.
    expect(result.usedFallback).toBe(true);
  });

  it('mergePr returns merged:true when PR merges immediately', async () => {
    // First call: gh pr merge (succeeds)
    execResponses.push({ stdout: '', stderr: '' });
    // Second call: gh pr view (status check — PR is merged)
    execResponses.push({
      stdout: JSON.stringify({
        state: 'MERGED',
        mergedAt: '2026-01-01T00:00:00Z',
        statusCheckRollup: null,
        reviewDecision: '',
        autoMergeRequest: null,
      }),
      stderr: '',
    });

    const manager = new GhPrManager({ logger });
    const result = await manager.mergePr({
      worktreePath: '/tmp/worktree',
      prUrl: 'https://github.com/org/repo/pull/42',
    });

    expect(result).toEqual({ merged: true, autoMergeScheduled: false });
  });

  it('mergePr returns merged:false when auto-merge is scheduled', async () => {
    // First call: gh pr merge --auto (succeeds but schedules auto-merge)
    execResponses.push({ stdout: '', stderr: '' });
    // Second call: gh pr view (PR still open, auto-merge scheduled)
    execResponses.push({
      stdout: JSON.stringify({
        state: 'OPEN',
        mergedAt: null,
        statusCheckRollup: [{ name: 'CI Build', status: 'IN_PROGRESS', conclusion: '' }],
        reviewDecision: 'REVIEW_REQUIRED',
        autoMergeRequest: { enabledAt: '2026-01-01T00:00:00Z' },
      }),
      stderr: '',
    });

    const manager = new GhPrManager({ logger });
    const result = await manager.mergePr({
      worktreePath: '/tmp/worktree',
      prUrl: 'https://github.com/org/repo/pull/42',
    });

    expect(result).toEqual({ merged: false, autoMergeScheduled: true });
  });

  it('getPrStatus returns merged when PR is merged', async () => {
    execResponses.push({
      stdout: JSON.stringify({
        state: 'MERGED',
        mergedAt: '2026-01-01T00:00:00Z',
        statusCheckRollup: null,
        reviewDecision: '',
        autoMergeRequest: null,
      }),
      stderr: '',
    });

    const manager = new GhPrManager({ logger });
    const status = await manager.getPrStatus({
      prUrl: 'https://github.com/org/repo/pull/42',
    });

    expect(status).toEqual({
      merged: true,
      open: false,
      blockReason: null,
      ciFailures: [],
      reviewComments: [],
      reviewDecision: 'APPROVED',
    });
  });

  it('getPrStatus returns blockReason with pending checks', async () => {
    execResponses.push({
      stdout: JSON.stringify({
        state: 'OPEN',
        mergedAt: null,
        statusCheckRollup: [
          { name: 'CI', status: 'IN_PROGRESS', conclusion: '' },
          { name: 'SAST', status: 'COMPLETED', conclusion: 'FAILURE' },
          { name: 'Lint', status: 'COMPLETED', conclusion: 'SUCCESS' },
        ],
        reviewDecision: 'APPROVED',
        autoMergeRequest: null,
      }),
      stderr: '',
    });

    const manager = new GhPrManager({ logger });
    const status = await manager.getPrStatus({
      prUrl: 'https://github.com/org/repo/pull/42',
    });

    expect(status.merged).toBe(false);
    expect(status.open).toBe(true);
    expect(status.blockReason).toContain('CI');
    expect(status.blockReason).toContain('SAST');
    expect(status.blockReason).not.toContain('Lint');
  });

  it('getPrStatus returns closed when PR is closed', async () => {
    execResponses.push({
      stdout: JSON.stringify({
        state: 'CLOSED',
        mergedAt: null,
        statusCheckRollup: null,
        reviewDecision: '',
        autoMergeRequest: null,
      }),
      stderr: '',
    });

    const manager = new GhPrManager({ logger });
    const status = await manager.getPrStatus({
      prUrl: 'https://github.com/org/repo/pull/42',
    });

    expect(status).toEqual({
      merged: false,
      open: false,
      blockReason: 'PR was closed without merging',
      ciFailures: [],
      reviewComments: [],
    });
  });

  it('getPrStatus includes feedback ids for unresolved change-request review threads', async () => {
    execResponses.push({
      stdout: JSON.stringify({
        state: 'OPEN',
        mergedAt: null,
        statusCheckRollup: null,
        reviewDecision: 'CHANGES_REQUESTED',
        autoMergeRequest: null,
      }),
      stderr: '',
    });
    execResponses.push({
      stdout: JSON.stringify({
        reviews: [
          {
            databaseId: 10,
            author: { login: 'alice' },
            state: 'CHANGES_REQUESTED',
            body: 'Please explain this edge case.',
          },
        ],
      }),
      stderr: '',
    });
    execResponses.push({
      stdout: JSON.stringify({
        data: {
          repository: {
            pullRequest: {
              reviewThreads: {
                nodes: [
                  {
                    id: 'PRRT_thread_123',
                    isResolved: false,
                    path: 'src/foo.ts',
                    comments: {
                      nodes: [
                        {
                          databaseId: 123,
                          author: { login: 'bob' },
                          body: 'Please add a null check.',
                          path: 'src/foo.ts',
                        },
                      ],
                    },
                  },
                  {
                    id: 'PRRT_thread_124',
                    isResolved: true,
                    path: 'src/foo.ts',
                    comments: {
                      nodes: [
                        {
                          databaseId: 124,
                          author: { login: 'carol' },
                          body: 'Already resolved.',
                          path: 'src/foo.ts',
                        },
                      ],
                    },
                  },
                ],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          },
        },
      }),
      stderr: '',
    });

    const manager = new GhPrManager({ logger });
    const status = await manager.getPrStatus({
      prUrl: 'https://github.com/org/repo/pull/42',
    });

    expect(status.reviewComments).toEqual([
      {
        id: 'gh-review-10',
        author: 'alice',
        body: 'Please explain this edge case.',
        path: null,
      },
      {
        id: 'gh-thread-PRRT_thread_123-comment-123',
        author: 'bob',
        body: 'Please add a null check.',
        path: 'src/foo.ts',
      },
    ]);
  });

  it('posts GitHub replies, resolves fixed threads, and preserves legacy fallbacks', async () => {
    const manager = new GhPrManager({ logger });

    const result = await manager.replyToReviewFeedback({
      prUrl: 'https://github.com/org/repo/pull/42',
      worktreePath: '/tmp/worktree',
      responses: [
        {
          feedbackId: 'gh-thread-PRRT_thread_123-comment-123',
          outcome: 'fixed',
          body: 'Autopod fix pod response: Fixed\n\nAdded the null check.',
        },
        {
          feedbackId: 'gh-comment-456',
          outcome: 'not_applicable',
          body: 'Autopod fix pod response: Not applicable\n\nThis is generated code.',
        },
        {
          feedbackId: 'gh-review-10',
          outcome: 'needs_reviewer_decision',
          body: 'Autopod fix pod response: Needs reviewer decision\n\nThis conflicts with API compatibility.',
        },
      ],
    });

    expect(result).toEqual({
      posted: 3,
      skipped: 1,
      resolved: 1,
      errors: [],
      resolutionErrors: [],
    });
    expect(execCalls[0]).toEqual([
      'gh',
      [
        'api',
        '--method',
        'POST',
        'repos/org/repo/pulls/42/comments/123/replies',
        '-f',
        'body=Autopod fix pod response: Fixed\n\nAdded the null check.',
      ],
      { cwd: '/tmp/worktree', timeout: 15_000 },
    ]);
    expect(execCalls[1]).toEqual([
      'gh',
      [
        'api',
        'graphql',
        '-f',
        expect.stringContaining('resolveReviewThread'),
        '-F',
        'threadId=PRRT_thread_123',
      ],
      { cwd: '/tmp/worktree', timeout: 15_000 },
    ]);
    expect(execCalls[2]).toEqual([
      'gh',
      [
        'api',
        '--method',
        'POST',
        'repos/org/repo/pulls/42/comments/456/replies',
        '-f',
        'body=Autopod fix pod response: Not applicable\n\nThis is generated code.',
      ],
      { cwd: '/tmp/worktree', timeout: 15_000 },
    ]);
    expect(execCalls[3]).toEqual([
      'gh',
      [
        'api',
        '--method',
        'POST',
        'repos/org/repo/issues/42/comments',
        '-f',
        expect.stringContaining('gh-review-10'),
      ],
      { cwd: '/tmp/worktree', timeout: 15_000 },
    ]);
  });
});

type MockFetchResponse = { ok: boolean; body: unknown; status?: number } | { error: Error };

function makeFetch(responses: MockFetchResponse[]) {
  let callIndex = 0;
  return vi.fn().mockImplementation(async () => {
    const response = responses[callIndex] ?? { ok: true, body: {} };
    callIndex++;
    if ('error' in response) throw response.error;
    return {
      ok: response.ok,
      status: response.status ?? (response.ok ? 200 : 500),
      json: async () => response.body,
      text: async () =>
        typeof response.body === 'string' ? response.body : JSON.stringify(response.body),
    };
  });
}

function reviewThreadsResponse() {
  return {
    data: {
      repository: {
        pullRequest: {
          reviewThreads: {
            nodes: [
              {
                id: 'PRRT_api_thread_123',
                isResolved: false,
                path: 'src/foo.ts',
                comments: {
                  nodes: [
                    {
                      databaseId: 123,
                      author: { login: 'bob' },
                      body: 'Please add a null check.',
                      path: null,
                    },
                  ],
                },
              },
              {
                id: 'PRRT_api_thread_124',
                isResolved: true,
                path: 'src/foo.ts',
                comments: {
                  nodes: [
                    {
                      databaseId: 124,
                      author: { login: 'carol' },
                      body: 'Already resolved.',
                      path: 'src/foo.ts',
                    },
                  ],
                },
              },
            ],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      },
    },
  };
}

describe('GitHubApiPrManager', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it('getPrStatus maps unresolved GraphQL review threads and skips resolved threads', async () => {
    const fetchMock = makeFetch([
      { ok: true, body: { state: 'open', merged: false, head: { sha: 'abc123' } } },
      { ok: true, body: { check_runs: [] } },
      {
        ok: true,
        body: [
          {
            id: 10,
            state: 'CHANGES_REQUESTED',
            user: { login: 'alice' },
            body: 'Please explain this edge case.',
          },
        ],
      },
      { ok: true, body: reviewThreadsResponse() },
    ]);
    vi.stubGlobal('fetch', fetchMock);

    const manager = new GitHubApiPrManager({ pat: 'secret', logger });
    const status = await manager.getPrStatus({
      prUrl: 'https://github.com/org/repo/pull/42',
    });

    expect(status.reviewComments).toEqual([
      {
        id: 'gh-review-10',
        author: 'alice',
        body: 'Please explain this edge case.',
        path: null,
      },
      {
        id: 'gh-thread-PRRT_api_thread_123-comment-123',
        author: 'bob',
        body: 'Please add a null check.',
        path: 'src/foo.ts',
      },
    ]);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.github.com/graphql',
      expect.objectContaining({
        method: 'POST',
        body: expect.stringContaining('AutopodReviewThreads'),
      }),
    );
  });

  it('posts API replies and resolves only fixed thread-aware feedback', async () => {
    const fetchMock = makeFetch([
      { ok: true, body: { id: 1 } },
      { ok: true, body: { data: { resolveReviewThread: { thread: { id: 'PRRT_fixed' } } } } },
      { ok: true, body: { id: 2 } },
      { ok: true, body: { id: 3 } },
      { ok: true, body: { id: 4 } },
    ]);
    vi.stubGlobal('fetch', fetchMock);

    const manager = new GitHubApiPrManager({ pat: 'secret', logger });
    const result = await manager.replyToReviewFeedback({
      prUrl: 'https://github.com/org/repo/pull/42',
      responses: [
        {
          feedbackId: 'gh-thread-PRRT_fixed-comment-101',
          outcome: 'fixed',
          body: 'Autopod fix pod response: Fixed\n\nDone.',
        },
        {
          feedbackId: 'gh-thread-PRRT_not_applicable-comment-102',
          outcome: 'not_applicable',
          body: 'Autopod fix pod response: Not applicable\n\nGenerated code.',
        },
        {
          feedbackId: 'gh-thread-PRRT_needs_decision-comment-103',
          outcome: 'needs_reviewer_decision',
          body: 'Autopod fix pod response: Needs reviewer decision\n\nConflicting guidance.',
        },
        {
          feedbackId: 'gh-thread-PRRT_could_not_verify-comment-104',
          outcome: 'could_not_verify',
          body: 'Autopod fix pod response: Could not verify\n\nMissing repro.',
        },
      ],
    });

    expect(result).toEqual({
      posted: 4,
      skipped: 0,
      resolved: 1,
      errors: [],
      resolutionErrors: [],
    });
    const calls = fetchMock.mock.calls as Array<[string, { body?: string }]>;
    expect(calls.filter(([url]) => url === 'https://api.github.com/graphql')).toHaveLength(1);
    expect(calls[1]?.[1].body).toContain('resolveReviewThread');
    expect(calls[1]?.[1].body).toContain('PRRT_fixed');
  });

  it('reports GitHub reply and resolution failures without throwing', async () => {
    const fetchMock = makeFetch([
      { error: new Error('network down') },
      { ok: true, body: { id: 2 } },
      { ok: false, status: 500, body: 'resolve failed' },
    ]);
    vi.stubGlobal('fetch', fetchMock);

    const manager = new GitHubApiPrManager({ pat: 'secret', logger });
    const result = await manager.replyToReviewFeedback({
      prUrl: 'https://github.com/org/repo/pull/42',
      responses: [
        {
          feedbackId: 'gh-comment-999',
          outcome: 'fixed',
          body: 'Autopod fix pod response: Fixed\n\nLegacy reply.',
        },
        {
          feedbackId: 'gh-thread-PRRT_fixed-comment-101',
          outcome: 'fixed',
          body: 'Autopod fix pod response: Fixed\n\nDone.',
        },
      ],
    });

    expect(result.posted).toBe(1);
    expect(result.resolved).toBe(0);
    expect(result.errors).toEqual(['network down']);
    expect(result.resolutionErrors).toEqual(['GitHub resolve error 500: resolve failed']);
  });
});
