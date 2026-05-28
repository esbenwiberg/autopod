import type { Profile } from '@autopod/shared';
import pino from 'pino';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GhPrManager } from './pr-manager.js';

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

  it('getPrStatus includes feedback ids for change-request review comments', async () => {
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
      stdout: JSON.stringify([
        {
          id: 123,
          user: { login: 'bob' },
          body: 'Please add a null check.',
          path: 'src/foo.ts',
        },
        {
          id: 124,
          in_reply_to_id: 123,
          user: { login: 'carol' },
          body: 'nested reply',
          path: 'src/foo.ts',
        },
      ]),
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
        id: 'gh-comment-123',
        author: 'bob',
        body: 'Please add a null check.',
        path: 'src/foo.ts',
      },
    ]);
  });

  it('posts host-side GitHub replies and falls back to a PR comment for review-body ids', async () => {
    const manager = new GhPrManager({ logger });

    const result = await manager.replyToReviewFeedback({
      prUrl: 'https://github.com/org/repo/pull/42',
      worktreePath: '/tmp/worktree',
      responses: [
        {
          feedbackId: 'gh-comment-123',
          body: 'Autopod fix pod response: Fixed\n\nAdded the null check.',
        },
        {
          feedbackId: 'gh-review-10',
          body: 'Autopod fix pod response: Needs reviewer decision\n\nThis conflicts with API compatibility.',
        },
      ],
    });

    expect(result).toEqual({ posted: 2, skipped: 1, errors: [] });
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
