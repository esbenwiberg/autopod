import pino from 'pino';
import { describe, expect, it, vi } from 'vitest';
import { GhPrManager } from './pr-manager.js';

// Track call count so we can return different responses for sequential calls
let callCount = 0;
const execResponses: Array<{ stdout: string; stderr: string }> = [];

vi.mock('node:util', async () => {
  const actual = await vi.importActual<typeof import('node:util')>('node:util');
  return {
    ...actual,
    promisify: vi.fn(() => {
      return async () => {
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
  });

  it('can be instantiated', () => {
    const manager = new GhPrManager({ logger });
    expect(manager).toBeDefined();
  });

  it('createPr returns trimmed PR URL', async () => {
    execResponses.push({ stdout: 'https://github.com/org/repo/pull/42\n', stderr: '' });
    const manager = new GhPrManager({ logger });

    const prUrl = await manager.createPr({
      worktreePath: '/tmp/worktree',
      branch: 'autopod/abc123',
      baseBranch: 'main',
      sessionId: 'abc123',
      task: 'Add dark mode',
      profileName: 'my-app',
      validationResult: null,
      filesChanged: 3,
      linesAdded: 50,
      linesRemoved: 10,
      previewUrl: null,
    });

    expect(prUrl).toBe('https://github.com/org/repo/pull/42');
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

    expect(status).toEqual({ merged: true, open: false, blockReason: null, ciFailures: [], reviewComments: [] });
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
});
