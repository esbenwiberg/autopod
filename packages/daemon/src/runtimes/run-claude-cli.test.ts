import { describe, expect, it } from 'vitest';
import { ClaudeCliError, runClaudeCli } from './run-claude-cli.js';

const MODEL = 'fake-model';

function bash(script: string) {
  return {
    command: '/bin/bash',
    args: ['-c', script] as const,
  };
}

describe('runClaudeCli', () => {
  it('resolves with stdout on exit 0', async () => {
    const { stdout } = await runClaudeCli({
      model: MODEL,
      input: '',
      timeout: 5_000,
      ...bash('printf hi'),
    });
    expect(stdout).toBe('hi');
  });

  it('extracts stdout and token usage from JSON output', async () => {
    const { stdout, tokenUsage } = await runClaudeCli({
      model: MODEL,
      input: '',
      timeout: 5_000,
      outputFormat: 'json',
      ...bash(
        `printf '%s' '{"type":"result","result":"review ok","total_cost_usd":0.0123,"usage":{"input_tokens":1234,"cache_read_input_tokens":1000,"output_tokens":56}}'`,
      ),
    });

    expect(stdout).toBe('review ok');
    expect(tokenUsage).toEqual({
      inputTokens: 1234,
      cachedInputTokens: 1000,
      outputTokens: 56,
      costUsd: 0.0123,
    });
  });

  it('non-zero exit with stderr — captures exit code and includes stderr in message', async () => {
    await expect(
      runClaudeCli({
        model: MODEL,
        input: '',
        timeout: 5_000,
        ...bash('echo oops >&2; exit 7'),
      }),
    ).rejects.toMatchObject({
      kind: 'non-zero-exit',
      exitCode: 7,
      signal: null,
    });

    try {
      await runClaudeCli({
        model: MODEL,
        input: '',
        timeout: 5_000,
        ...bash('echo oops >&2; exit 7'),
      });
    } catch (err) {
      expect(err).toBeInstanceOf(ClaudeCliError);
      const e = err as ClaudeCliError;
      expect(e.stderr).toContain('oops');
      expect(e.message).toContain('exit=7');
      expect(e.message).toContain('oops');
    }
  });

  it('non-zero exit with empty stderr — message hints at external kill', async () => {
    try {
      await runClaudeCli({
        model: MODEL,
        input: '',
        timeout: 5_000,
        ...bash('exit 1'),
      });
      throw new Error('should have rejected');
    } catch (err) {
      expect(err).toBeInstanceOf(ClaudeCliError);
      const e = err as ClaudeCliError;
      expect(e.kind).toBe('non-zero-exit');
      expect(e.exitCode).toBe(1);
      expect(e.signal).toBeNull();
      expect(e.stderr).toBe('');
      expect(e.message).toContain('no stderr captured');
      expect(e.message).toContain('OOM');
    }
  });

  it('signal kill — captures signal and notes it in the message', async () => {
    try {
      await runClaudeCli({
        model: MODEL,
        input: '',
        timeout: 5_000,
        ...bash('kill -9 $$'),
      });
      throw new Error('should have rejected');
    } catch (err) {
      expect(err).toBeInstanceOf(ClaudeCliError);
      const e = err as ClaudeCliError;
      expect(e.kind).toBe('non-zero-exit');
      expect(e.exitCode).toBeNull();
      expect(e.signal).toBe('SIGKILL');
      expect(e.message).toContain('SIGKILL');
    }
  });

  it('timeout — kind=timeout and durationMs >= timeout', async () => {
    const start = Date.now();
    try {
      await runClaudeCli({
        model: MODEL,
        input: '',
        timeout: 100,
        ...bash('sleep 5'),
      });
      throw new Error('should have rejected');
    } catch (err) {
      expect(err).toBeInstanceOf(ClaudeCliError);
      const e = err as ClaudeCliError;
      expect(e.kind).toBe('timeout');
      expect(e.durationMs).toBeGreaterThanOrEqual(100);
      expect(Date.now() - start).toBeLessThan(2_000);
      expect(e.message).toContain('timed out after 100ms');
    }
  });

  it('maxbuffer — kind=maxbuffer when stdout exceeds limit', async () => {
    try {
      await runClaudeCli({
        model: MODEL,
        input: '',
        timeout: 5_000,
        maxBuffer: 64,
        ...bash('yes a | head -c 5000'),
      });
      throw new Error('should have rejected');
    } catch (err) {
      expect(err).toBeInstanceOf(ClaudeCliError);
      const e = err as ClaudeCliError;
      expect(e.kind).toBe('maxbuffer');
      expect(e.message).toContain('maxBuffer');
    }
  });

  it('spawn-error — kind=spawn-error when binary is missing', async () => {
    try {
      await runClaudeCli({
        model: MODEL,
        input: '',
        timeout: 5_000,
        command: '/no/such/binary-runclaudecli-test',
        args: [],
      });
      throw new Error('should have rejected');
    } catch (err) {
      expect(err).toBeInstanceOf(ClaudeCliError);
      const e = err as ClaudeCliError;
      expect(e.kind).toBe('spawn-error');
      expect(e.message).toContain('failed to spawn');
      expect(e.message).toMatch(/ENOENT/);
    }
  });
});
