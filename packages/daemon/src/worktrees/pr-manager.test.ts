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
const githubAuth = {
  resolveCredential: vi.fn(async () => ({ token: 'daemon-gh-token', username: 'x-access-token' })),
  getStatus: vi.fn(),
};

describe('GhPrManager', () => {
  beforeEach(() => {
    githubAuth.resolveCredential.mockClear();
    callCount = 0;
    execResponses.length = 0;
    execCalls.length = 0;
  });

  it('pins an expected source commit without scheduling a later merge or deleting the branch', async () => {
    const sha = 'a'.repeat(40);
    execResponses.push(
      { stdout: '', stderr: '' },
      {
        stdout: JSON.stringify({
          state: 'MERGED',
          headRefOid: sha,
          statusCheckRollup: null,
        }),
        stderr: '',
      },
    );
    const result = await new GhPrManager({ logger, githubAuth }).mergePr({
      prUrl: 'https://github.com/org/repo/pull/42',
      expectedHeadSha: sha,
    });
    expect(result.merged).toBe(true);
    expect(execCalls[0]?.[1]).toEqual(expect.arrayContaining(['--match-head-commit', sha]));
    expect(execCalls[0]?.[1]).not.toEqual(expect.arrayContaining(['--auto']));
    expect(execCalls[0]?.[1]).not.toEqual(expect.arrayContaining(['--delete-branch']));
  });

  it.each([undefined, 'b'.repeat(40)])(
    'rejects a merged CLI observation with unconfirmed source %s',
    async (headRefOid) => {
      execResponses.push(
        { stdout: '', stderr: '' },
        {
          stdout: JSON.stringify({
            state: 'MERGED',
            headRefOid,
            statusCheckRollup: null,
          }),
          stderr: '',
        },
      );
      await expect(
        new GhPrManager({ logger, githubAuth }).mergePr({
          prUrl: 'https://github.com/org/repo/pull/42',
          expectedHeadSha: 'a'.repeat(40),
        }),
      ).rejects.toMatchObject({ code: 'DELIVERY_RECONCILIATION_REQUIRED' });
    },
  );

  it('can be instantiated', () => {
    const manager = new GhPrManager({ logger, githubAuth });
    expect(manager).toBeDefined();
  });

  it('looks up exact head/base across all states and refuses ambiguous or cross-repository matches', async () => {
    const row = {
      url: 'https://github.com/org/repo/pull/42',
      state: 'MERGED',
      headRefName: 'feature',
      baseRefName: 'main',
      isCrossRepository: false,
    };
    execResponses.push(
      { stdout: JSON.stringify([row]), stderr: '' },
      { stdout: JSON.stringify([row, row]), stderr: '' },
      { stdout: JSON.stringify([{ ...row, isCrossRepository: true }]), stderr: '' },
    );
    const manager = new GhPrManager({ logger, githubAuth });
    const config = {
      worktreePath: '/tmp/worktree',
      repoUrl: 'https://github.com/org/repo',
      branch: 'feature',
      baseBranch: 'main',
    };
    expect(await manager.findPr(config)).toEqual({ url: row.url, disposition: 'merged' });
    expect(execCalls[0]?.[1]).toEqual(
      expect.arrayContaining([
        '--state',
        'all',
        '--head',
        'feature',
        '--base',
        'main',
        '--limit',
        '2',
      ]),
    );
    await expect(manager.findPr(config)).rejects.toThrow('ambiguous');
    await expect(manager.findPr(config)).rejects.toThrow('exact');
  });

  it('createPr returns trimmed PR URL with fallback metadata', async () => {
    execResponses.push({ stdout: 'https://github.com/org/repo/pull/42\n', stderr: '' });
    const manager = new GhPrManager({ logger, githubAuth });

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

    const manager = new GhPrManager({ logger, githubAuth });
    const result = await manager.mergePr({
      worktreePath: '/tmp/worktree',
      prUrl: 'https://github.com/org/repo/pull/42',
    });

    expect(result).toEqual({ merged: true, autoMergeScheduled: false });
    expect(execCalls[0]?.[2]).not.toHaveProperty('cwd');
    expect(execCalls[1]?.[2]).not.toHaveProperty('cwd');
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

    const manager = new GhPrManager({ logger, githubAuth });
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

    const manager = new GhPrManager({ logger, githubAuth });
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
    expect(execCalls[0]?.[2]).not.toHaveProperty('cwd');
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

    const manager = new GhPrManager({ logger, githubAuth });
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

    const manager = new GhPrManager({ logger, githubAuth });
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

    const manager = new GhPrManager({ logger, githubAuth });
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
    const manager = new GhPrManager({ logger, githubAuth });

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
      expect.objectContaining({
        cwd: '/tmp/worktree',
        timeout: 15_000,
        env: expect.objectContaining({ GH_TOKEN: 'daemon-gh-token' }),
      }),
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
      expect.objectContaining({
        cwd: '/tmp/worktree',
        timeout: 15_000,
        env: expect.objectContaining({ GH_TOKEN: 'daemon-gh-token' }),
      }),
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
      expect.objectContaining({
        cwd: '/tmp/worktree',
        timeout: 15_000,
        env: expect.objectContaining({ GH_TOKEN: 'daemon-gh-token' }),
      }),
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
      expect.objectContaining({
        cwd: '/tmp/worktree',
        timeout: 15_000,
        env: expect.objectContaining({ GH_TOKEN: 'daemon-gh-token' }),
      }),
    ]);
    expect(githubAuth.resolveCredential).toHaveBeenCalledTimes(4);
    for (const call of execCalls) {
      const options = call[2] as { env?: NodeJS.ProcessEnv };
      expect(options.env?.GH_TOKEN).toBe('daemon-gh-token');
      expect(options.env?.GITHUB_TOKEN).toBeUndefined();
    }
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

  it('sends the expected source SHA to the GitHub merge condition and preserves the branch', async () => {
    const sha = 'a'.repeat(40);
    const fetchMock = makeFetch([
      { ok: true, body: { head: { ref: 'feature', sha } } },
      { ok: true, body: { merged: true, sha: 'c'.repeat(40) } },
    ]);
    vi.stubGlobal('fetch', fetchMock);
    const result = await new GitHubApiPrManager({ pat: 'local-token', logger }).mergePr({
      prUrl: 'https://github.com/org/repo/pull/42',
      expectedHeadSha: sha,
    });
    expect(result).toEqual({ merged: true, autoMergeScheduled: false });
    expect(JSON.parse(fetchMock.mock.calls[1]?.[1].body)).toMatchObject({ sha });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each([undefined, 'b'.repeat(40)])(
    'refuses GitHub mutation when observed source is %s',
    async (sha) => {
      const fetchMock = makeFetch([{ ok: true, body: { head: { ref: 'feature', sha } } }]);
      vi.stubGlobal('fetch', fetchMock);
      await expect(
        new GitHubApiPrManager({ pat: 'local-token', logger }).mergePr({
          prUrl: 'https://github.com/org/repo/pull/42',
          expectedHeadSha: 'a'.repeat(40),
        }),
      ).rejects.toMatchObject({ code: 'DELIVERY_RECONCILIATION_REQUIRED' });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    },
  );

  it.each([{}, { merged: false }, { merged: 'true' }, null])(
    'requires an explicit GitHub merge confirmation: %j',
    async (body) => {
      const sha = 'a'.repeat(40);
      const fetchMock = makeFetch([
        { ok: true, body: { head: { ref: 'feature', sha } } },
        { ok: true, body },
      ]);
      vi.stubGlobal('fetch', fetchMock);
      await expect(
        new GitHubApiPrManager({ pat: 'local-token', logger }).mergePr({
          prUrl: 'https://github.com/org/repo/pull/42',
          expectedHeadSha: sha,
        }),
      ).rejects.toMatchObject({ code: 'DELIVERY_RECONCILIATION_REQUIRED' });
      expect(fetchMock).toHaveBeenCalledTimes(2);
    },
  );

  it('looks up exact repository/head/base with bounded authenticated GET and rejects errors as absence', async () => {
    const row = {
      html_url: 'https://github.com/org/repo/pull/42',
      state: 'closed',
      merged_at: '2026-09-07',
      head: { ref: 'feature/a', repo: { full_name: 'org/repo' } },
      base: { ref: 'main' },
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => [row] })
      .mockResolvedValueOnce({ ok: false, status: 401 });
    vi.stubGlobal('fetch', fetchMock);
    const manager = new GitHubApiPrManager({ pat: 'local-token', logger });
    const config = {
      worktreePath: '/tmp/fixture',
      repoUrl: 'https://github.com/org/repo',
      branch: 'feature/a',
      baseBranch: 'main',
    };
    expect(await manager.findPr(config)).toEqual({ url: row.html_url, disposition: 'merged' });
    const [url, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(new URL(url).searchParams.get('head')).toBe('org:feature/a');
    expect(new URL(url).searchParams.get('state')).toBe('all');
    expect(new URL(url).searchParams.get('per_page')).toBe('2');
    expect(options.headers).toMatchObject({ Authorization: 'Bearer local-token' });
    await expect(manager.findPr(config)).rejects.toThrow('HTTP 401');
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
