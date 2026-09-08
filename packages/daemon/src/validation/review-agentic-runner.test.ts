import { spawn } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import { createMockChildProcess } from '../test-utils/mock-helpers.js';
import { parseAgenticReviewOutput, runAgenticReview } from './review-agentic-runner.js';

describe('parseAgenticReviewOutput', () => {
  it('extracts the verdict and telemetry from Claude JSON output', () => {
    const result = parseAgenticReviewOutput(
      JSON.stringify({
        result: '{"status":"pass","reasoning":"clean","issues":[]}',
        usage: {
          input_tokens: 300,
          cache_read_input_tokens: 120,
          cache_creation_input_tokens: 80,
          output_tokens: 30,
        },
        total_cost_usd: 0.012,
      }),
    );

    expect(result).toEqual({
      stdout: '{"status":"pass","reasoning":"clean","issues":[]}',
      tokenUsage: {
        inputTokens: 500,
        cachedInputTokens: 120,
        cacheCreationInputTokens: 80,
        outputTokens: 30,
        costUsd: 0.012,
      },
    });
  });
});

vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  spawn: vi.fn(),
}));

describe('agentic reviewer cancellation', () => {
  it('forwards the ownership fence to the actual agentic host spawn', async () => {
    const { child } = createMockChildProcess();
    vi.mocked(spawn)
      .mockClear()
      .mockImplementation(() => {
        queueMicrotask(() => child.emit('close', 0, null));
        return child;
      });
    const result = await runAgenticReview({
      model: 'test',
      prompt: 'review',
      worktreePath: '/tmp',
      timeout: 1000,
      beforeSpawn: () => {
        throw new Error('review ownership lost');
      },
    }).catch((error: unknown) => error);
    expect(spawn).not.toHaveBeenCalled();
    expect(result).toMatchObject({ message: 'review ownership lost' });
  });

  it('preserves the actual agentic command, directory, stdin and telemetry', async () => {
    const { child } = createMockChildProcess();
    vi.mocked(spawn).mockReturnValue(child);
    let input = '';
    child.stdin?.on('data', (chunk) => {
      input += String(chunk);
    });
    const beforeSpawn = vi.fn();
    const pending = runAgenticReview({
      beforeSpawn,
      model: 'chosen-model',
      prompt: 'private review prompt',
      worktreePath: '/tmp/review-worktree',
      timeout: 1000,
    });
    expect(spawn).toHaveBeenLastCalledWith(
      'claude',
      expect.arrayContaining([
        '--model',
        'chosen-model',
        '--allowedTools',
        'Read',
        'Bash(git diff:*)',
        '--add-dir',
        '/tmp/review-worktree',
      ]),
      expect.objectContaining({
        cwd: '/tmp/review-worktree',
        env: expect.objectContaining({ GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '' }),
      }),
    );
    expect(vi.mocked(spawn).mock.calls.at(-1)?.[1]).not.toContain('private review prompt');
    expect(input).toBe('private review prompt');
    expect(beforeSpawn).toHaveBeenCalledOnce();
    child.stdout?.emit(
      'data',
      Buffer.from(
        JSON.stringify({
          result: 'verdict',
          total_cost_usd: 0.1,
          usage: { input_tokens: 10, output_tokens: 2 },
        }),
      ),
    );
    child.emit('exit', 0, null);
    child.emit('close', 0, null);
    expect(await pending).toEqual({
      stdout: 'verdict',
      tokenUsage: { inputTokens: 10, outputTokens: 2, costUsd: 0.1 },
    });
  });

  it('waits for observed exit after timeout without launching a provider', async () => {
    vi.useFakeTimers();
    try {
      const { child, kill } = createMockChildProcess();
      vi.mocked(spawn).mockReturnValue(child);
      let result: unknown;
      const pending = runAgenticReview({
        model: 'test',
        prompt: 'review',
        worktreePath: '/tmp',
        timeout: 100,
      }).catch((error: unknown) => {
        result = error;
      });
      await vi.advanceTimersByTimeAsync(100);
      expect(kill).toHaveBeenCalledWith('SIGTERM');
      expect(result).toBeUndefined();
      child.emit('exit', null, 'SIGTERM');
      child.emit('close', null, 'SIGTERM');
      await pending;
      expect(result).toMatchObject({ kind: 'timeout' });
    } finally {
      vi.useRealTimers();
    }
  });
});
