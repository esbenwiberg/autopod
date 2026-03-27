import type { Session } from '@autopod/shared';
import { describe, expect, it, vi } from 'vitest';

// Mock child_process.execFile so promisify(execFile) returns our mock
vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
}));

import { execFile } from 'node:child_process';
import { buildContinuationPrompt, buildRecoveryTask } from './recovery-context.js';

// Helper: make execFile's callback-based API behave like the promisified version
// promisify(execFile) calls execFile(cmd, args, opts, callback)
const mockedExecFile = vi.mocked(execFile);

function mockExecFileResults(results: Array<{ stdout: string; stderr?: string } | Error>) {
  let callIndex = 0;
  mockedExecFile.mockImplementation((...args: unknown[]) => {
    const callback = args[args.length - 1] as (
      err: Error | null,
      result: { stdout: string; stderr: string },
    ) => void;
    const result = results[callIndex++];
    if (result instanceof Error) {
      callback(result, { stdout: '', stderr: '' });
    } else {
      callback(null, { stdout: result.stdout, stderr: result.stderr ?? '' });
    }
    return undefined as never;
  });
}

function makeSession(overrides?: Partial<Session>): Session {
  return {
    id: 'ses-recovery',
    profileName: 'test-profile',
    task: 'Implement dark mode for the settings page',
    status: 'queued',
    model: 'opus',
    runtime: 'claude',
    executionTarget: 'local',
    branch: 'autopod/ses-recovery',
    containerId: null,
    worktreePath: '/tmp/worktree/recovery',
    validationAttempts: 0,
    maxValidationAttempts: 3,
    lastValidationResult: null,
    pendingEscalation: null,
    escalationCount: 0,
    skipValidation: false,
    createdAt: new Date().toISOString(),
    startedAt: new Date().toISOString(),
    completedAt: null,
    updatedAt: new Date().toISOString(),
    userId: 'user-1',
    filesChanged: 5,
    linesAdded: 120,
    linesRemoved: 30,
    previewUrl: null,
    prUrl: null,
    plan: null,
    progress: null,
    acceptanceCriteria: null,
    claudeSessionId: null,
    outputMode: 'pr',
    baseBranch: null,
    acFrom: null,
    recoveryWorktreePath: null,
    ...overrides,
  };
}

describe('buildContinuationPrompt', () => {
  it('includes git log and uncommitted diff when both present', async () => {
    const gitLog = 'abc1234 Add settings page scaffold\ndef5678 Wire up theme toggle';
    const diffStat =
      ' src/settings.ts | 15 +++++++++------\n 1 file changed, 9 insertions(+), 6 deletions(-)';

    // First call: git log, second call: git diff HEAD --stat
    mockExecFileResults([{ stdout: gitLog }, { stdout: diffStat }]);

    const session = makeSession();
    const prompt = await buildContinuationPrompt(session, '/tmp/worktree/recovery');

    expect(prompt).toContain('session was interrupted');
    expect(prompt).toContain('Implement dark mode for the settings page');
    expect(prompt).toContain('Recent commits on this branch:');
    expect(prompt).toContain('abc1234 Add settings page scaffold');
    expect(prompt).toContain('Uncommitted changes:');
    expect(prompt).toContain('src/settings.ts');
    expect(prompt).toContain('continue');
  });

  it('says "no commits yet" when git log returns empty', async () => {
    mockExecFileResults([{ stdout: '' }, { stdout: '' }]);

    const session = makeSession();
    const prompt = await buildContinuationPrompt(session, '/tmp/worktree/recovery');

    expect(prompt).toContain('No commits on this branch yet.');
    expect(prompt).toContain('No uncommitted changes.');
  });

  it('handles git command failures gracefully', async () => {
    mockExecFileResults([new Error('fatal: not a git repository'), new Error('git diff failed')]);

    const session = makeSession();
    const prompt = await buildContinuationPrompt(session, '/tmp/worktree/recovery');

    // Should not throw, should include fallback text
    expect(prompt).toContain('No commits on this branch yet.');
    expect(prompt).toContain('No uncommitted changes.');
    expect(prompt).toContain('Implement dark mode for the settings page');
  });

  it('includes commits but no uncommitted changes when diff is empty', async () => {
    const gitLog = 'abc1234 Complete implementation';
    mockExecFileResults([{ stdout: gitLog }, { stdout: '' }]);

    const session = makeSession();
    const prompt = await buildContinuationPrompt(session, '/tmp/worktree/recovery');

    expect(prompt).toContain('Recent commits on this branch:');
    expect(prompt).toContain('abc1234 Complete implementation');
    expect(prompt).toContain('No uncommitted changes.');
  });
});

describe('buildRecoveryTask', () => {
  it('wraps original task with recovery context', async () => {
    const gitLog = 'abc1234 First commit';
    mockExecFileResults([{ stdout: gitLog }, { stdout: '' }]);

    const session = makeSession({ task: 'Fix the login bug' });
    const task = await buildRecoveryTask(session, '/tmp/worktree/recovery');

    // Should start with original task
    expect(task).toMatch(/^Fix the login bug/);
    // Should include recovery marker
    expect(task).toContain('RECOVERY CONTEXT:');
    // Should include continuation prompt content
    expect(task).toContain('session was interrupted');
    expect(task).toContain('abc1234 First commit');
  });

  it('includes both original task and recovery context when git fails', async () => {
    mockExecFileResults([new Error('git error'), new Error('git error')]);

    const session = makeSession({ task: 'Build the dashboard' });
    const task = await buildRecoveryTask(session, '/tmp/worktree/recovery');

    expect(task).toContain('Build the dashboard');
    expect(task).toContain('RECOVERY CONTEXT:');
    expect(task).toContain('No commits on this branch yet.');
  });
});
