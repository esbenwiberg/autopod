import { type ChildProcess, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createMockChildProcess } from '../test-utils/mock-helpers.js';
import { ClaudeCliError, runClaudeCli } from './run-claude-cli.js';

const MODEL = 'fake-model';

function bash(script: string) {
  return {
    command: '/bin/bash',
    args: ['-c', script] as const,
  };
}

describe('runClaudeCli', () => {
  it.each([
    'missing',
    'invalid-version',
    'changed-executable',
    'deleted-executable',
    'timeout',
  ] as const)('blocks host review when CLI provenance is %s', async (fault) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'autopod-host-blocked-'));
    const command = path.join(directory, 'claude');
    const probe =
      fault === 'timeout'
        ? 'exec /bin/sleep 1'
        : fault === 'deleted-executable'
          ? 'rm -- "$0"; echo "2.9.1"'
          : fault === 'changed-executable'
            ? 'echo "# changed" >> "$0"; echo "2.9.1"'
            : 'echo "version unavailable"';
    if (fault !== 'missing')
      await fs.writeFile(
        command,
        `#!/bin/sh\nif [ "$1" = "--version" ]; then ${probe}; exit 0; fi\necho dispatched > dispatch.txt\n`,
        { mode: 0o700 },
      );
    const recordHostDispatch = vi.fn();
    try {
      await expect(
        runClaudeCli({
          model: MODEL,
          command,
          input: 'review',
          timeout: fault === 'timeout' ? 100 : 2000,
          spawnOptions: { cwd: directory },
          recordHostDispatch,
        }),
      ).rejects.toBeInstanceOf(Error);
      expect(recordHostDispatch).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'blocked', model: MODEL }),
      );
      await expect(fs.stat(path.join(directory, 'dispatch.txt'))).rejects.toMatchObject({
        code: 'ENOENT',
      });
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  it.each([false, true])(
    'records observed host CLI version before dispatch; receipt rejection=%s',
    async (rejectReceipt) => {
      const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'autopod-host-reviewer-'));
      const command = path.join(directory, 'claude');
      const dispatch = path.join(directory, 'dispatch.txt');
      await fs.writeFile(
        command,
        '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "2.9.1 (fixture)"; exit 0; fi\necho dispatched > dispatch.txt\necho fixture-verdict\n',
        { mode: 0o700 },
      );
      const recordHostDispatch = vi.fn(() => {
        if (rejectReceipt) throw new Error('fixture receipt rejected');
      });
      try {
        const result = runClaudeCli({
          model: MODEL,
          input: 'review',
          timeout: 1000,
          command,
          spawnOptions: { cwd: directory },
          recordHostDispatch,
        });
        if (rejectReceipt) {
          await expect(result).rejects.toThrow('fixture receipt rejected');
          await expect(fs.stat(dispatch)).rejects.toMatchObject({ code: 'ENOENT' });
        } else {
          expect((await result).stdout.trim()).toBe('fixture-verdict');
          expect(await fs.readFile(dispatch, 'utf8')).toBe('dispatched\n');
        }
        expect(recordHostDispatch).toHaveBeenCalledWith(
          expect.objectContaining({
            model: MODEL,
            cliPath: await fs.realpath(command),
            cliVersion: '2.9.1',
            status: 'checked',
          }),
        );
      } finally {
        await fs.rm(directory, { recursive: true, force: true });
      }
    },
  );

  it('checks reviewer ownership immediately before host spawn', async () => {
    const { child } = createMockChildProcess();
    const spawnImpl = vi.fn(() => {
      queueMicrotask(() => child.emit('close', 0, null));
      return child;
    });
    const result = await runClaudeCli({
      model: MODEL,
      input: '',
      timeout: 1000,
      spawnImpl,
      beforeSpawn: () => {
        throw new Error('review ownership lost');
      },
    }).catch((error: unknown) => error);
    expect(spawnImpl).not.toHaveBeenCalled();
    expect(result).toMatchObject({ message: 'review ownership lost' });
  });

  it.each(['timeout', 'maxbuffer'])(
    'waits for observed exit after %s cancellation',
    async (kind) => {
      vi.useFakeTimers();
      try {
        const { child, kill } = createMockChildProcess();
        let result: unknown;
        const pending = runClaudeCli({
          model: MODEL,
          input: '',
          timeout: 100,
          maxBuffer: 4,
          spawnImpl: () => child,
        }).catch((error: unknown) => {
          result = error;
        });
        if (kind === 'maxbuffer') child.stdout?.emit('data', Buffer.from('too much'));
        else await vi.advanceTimersByTimeAsync(100);
        await Promise.resolve();
        expect(kill).toHaveBeenCalledWith('SIGTERM');
        expect(result).toBeUndefined();
        child.emit('exit', null, 'SIGTERM');
        child.emit('close', null, 'SIGTERM');
        await pending;
        expect(result).toMatchObject({ kind });
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it('reports unconfirmed termination after bounded signal escalation', async () => {
    vi.useFakeTimers();
    try {
      const { child, kill } = createMockChildProcess();
      let result: unknown;
      const pending = runClaudeCli({
        model: MODEL,
        input: '',
        timeout: 100,
        spawnImpl: () => child,
      }).catch((error: unknown) => {
        result = error;
      });
      await vi.advanceTimersByTimeAsync(10100);
      expect(kill.mock.calls.map(([signal]) => signal)).toEqual(['SIGTERM', 'SIGKILL']);
      expect(result).toMatchObject({ kind: 'termination-failed' });
      await pending;
      child.emit('exit', null, 'SIGKILL');
      child.emit('close', null, 'SIGKILL');
      expect(result).toMatchObject({ kind: 'termination-failed' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('uses observed exit when a cancelled collector still has open pipes', async () => {
    vi.useFakeTimers();
    try {
      const { child, kill } = createMockChildProcess();
      const pending = runClaudeCli({
        model: MODEL,
        input: '',
        timeout: 100,
        spawnImpl: () => child,
      }).catch((error: unknown) => error);
      child.emit('exit', 0, null);
      await vi.advanceTimersByTimeAsync(100);
      expect(await pending).toMatchObject({ kind: 'timeout', exitCode: 0 });
      expect(kill).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('observes a real owned process exit after SIGTERM is ignored', async () => {
    let child: ChildProcess | undefined;
    try {
      await expect(
        runClaudeCli({
          model: MODEL,
          input: '',
          timeout: 500,
          command: process.execPath,
          args: ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 100);"],
          spawnImpl: (command, args, options) => {
            child = spawn(command, args, options);
            return child;
          },
        }),
      ).rejects.toMatchObject({ kind: 'timeout', signal: 'SIGKILL' });
      expect(child?.signalCode).toBe('SIGKILL');
      expect(child?.pid).toBeGreaterThan(0);
      expect(() => process.kill(child?.pid ?? 0, 0)).toThrow(
        expect.objectContaining({ code: 'ESRCH' }),
      );
    } finally {
      child?.kill('SIGKILL');
    }
  }, 15_000);

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
        `printf '%s' '{"type":"result","result":"review ok","total_cost_usd":0.0123,"usage":{"input_tokens":1234,"cache_read_input_tokens":1000,"cache_creation_input_tokens":200,"output_tokens":56}}'`,
      ),
    });

    expect(stdout).toBe('review ok');
    expect(tokenUsage).toEqual({
      inputTokens: 2434,
      cachedInputTokens: 1000,
      cacheCreationInputTokens: 200,
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

  it('non-zero exit with stdout but empty stderr — includes stdout diagnostic', async () => {
    try {
      await runClaudeCli({
        model: MODEL,
        input: '',
        timeout: 5_000,
        ...bash('printf \'{"result":"Not logged in - Please run /login"}\'; exit 1'),
      });
      throw new Error('should have rejected');
    } catch (err) {
      expect(err).toBeInstanceOf(ClaudeCliError);
      const e = err as ClaudeCliError;
      expect(e.kind).toBe('non-zero-exit');
      expect(e.exitCode).toBe(1);
      expect(e.stderr).toBe('');
      expect(e.stdoutPreview).toContain('Not logged in');
      expect(e.message).toContain('stdout:');
      expect(e.message).toContain('Not logged in');
      expect(e.message).not.toContain('OOM');
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
