import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import type {
  ContainerManager,
  ExecOptions,
  ExecResult,
  StreamingExecResult,
} from '../interfaces/container-manager.js';
import { runCodexReview } from './review-codex-runner.js';

interface CapturedExec {
  command: string[];
  options?: ExecOptions;
}

function createHarness(
  result: ExecResult = { stdout: '{"status":"pass"}', stderr: '', exitCode: 0 },
  log = '',
) {
  const writes: Array<{ containerId: string; path: string; content: string | Buffer }> = [];
  const execs: CapturedExec[] = [];
  const reads: Array<{ containerId: string; path: string }> = [];
  const manager: Pick<ContainerManager, 'writeFile' | 'execInContainer' | 'readFile'> = {
    async writeFile(containerId, path, content) {
      writes.push({ containerId, path, content });
    },
    async execInContainer(_containerId, command, options) {
      execs.push({ command, options });
      return result;
    },
    async readFile(containerId, path) {
      reads.push({ containerId, path });
      return log;
    },
  };

  return { manager: manager as ContainerManager, writes, execs, reads };
}

describe('runCodexReview', () => {
  it.each(['probe-rejected', 'ownership-lost'] as const)(
    'does not launch Codex after %s',
    async (failure) => {
      const harness = createHarness();
      const beforeLaunch = vi.fn(async () => {
        expect(harness.writes).toHaveLength(1);
        if (failure === 'probe-rejected') throw new Error('review probe rejected');
        return () => {
          throw new Error('review ownership lost');
        };
      });
      await expect(
        runCodexReview({
          podId: 'pod',
          containerId: 'container',
          containerManager: harness.manager,
          model: 'review-model',
          prompt: 'review',
          timeout: 1000,
          beforeLaunch,
        }),
      ).rejects.toThrow(/review probe rejected|review ownership lost/);
      expect(beforeLaunch).toHaveBeenCalledWith({
        podId: 'pod',
        containerId: 'container',
        runtime: 'codex',
        model: 'review-model',
      });
      expect(harness.execs.every((exec) => exec.command[0] === 'rm')).toBe(true);
    },
  );

  it('rechecks ownership before buffered fallback after unsupported streaming', async () => {
    const harness = createHarness();
    let current = true;
    harness.manager.supportsStreamingExec = true;
    harness.manager.execStreaming = vi.fn(async () => {
      current = false;
      throw new Error('streaming exec is not supported');
    });
    const beforeLaunch = async () => () => {
      if (!current) throw new Error('review ownership lost');
    };
    await expect(
      runCodexReview({
        podId: 'pod',
        containerId: 'container',
        containerManager: harness.manager,
        model: 'review-model',
        prompt: 'review',
        timeout: 1000,
        beforeLaunch,
      }),
    ).rejects.toThrow('review ownership lost');
    expect(harness.manager.execStreaming).toHaveBeenCalledTimes(1);
    expect(harness.execs.every((exec) => exec.command[0] === 'rm')).toBe(true);
  });

  it('subtracts streaming negotiation time before buffered review fallback', async () => {
    vi.useFakeTimers({ toFake: ['performance', 'setTimeout', 'clearTimeout'] });
    try {
      const harness = createHarness();
      harness.manager.supportsStreamingExec = true;
      harness.manager.execStreaming = vi.fn(async () => {
        await new Promise<void>((resolve) => setTimeout(resolve, 30));
        throw new Error('streaming exec is not supported');
      });
      const pending = runCodexReview({
        podId: 'pod',
        containerId: 'container',
        containerManager: harness.manager,
        model: 'review-model',
        prompt: 'review',
        timeout: 100,
        beforeLaunch: async () => () => {},
      });
      await vi.advanceTimersByTimeAsync(31);
      await pending;
      expect(harness.execs[0]?.command[0]).toBe('sh');
      expect(harness.execs[0]?.options?.timeout).toBeGreaterThan(0);
      expect(harness.execs[0]?.options?.timeout).toBeLessThanOrEqual(70);
    } finally {
      vi.useRealTimers();
    }
  });

  it('subtracts preflight time from the existing reviewer execution timeout', async () => {
    vi.useFakeTimers({ toFake: ['performance', 'setTimeout', 'clearTimeout'] });
    try {
      const harness = createHarness();
      const beforeLaunch = async () => {
        await new Promise<void>((resolve) => setTimeout(resolve, 30));
        return () => {};
      };
      const pending = runCodexReview({
        podId: 'pod',
        containerId: 'container',
        containerManager: harness.manager,
        model: 'review-model',
        prompt: 'review',
        timeout: 100,
        beforeLaunch,
      });
      await vi.advanceTimersByTimeAsync(31);
      await pending;
      expect(harness.execs[0]?.options?.timeout).toBeGreaterThan(0);
      expect(harness.execs[0]?.options?.timeout).toBeLessThanOrEqual(70);
    } finally {
      vi.useRealTimers();
    }
  });

  it('builds a valid shell script around the Codex CLI call', async () => {
    const harness = createHarness();

    const launchGuard = vi.fn();
    const beforeLaunch = vi.fn(async () => launchGuard);
    await runCodexReview({
      beforeLaunch,
      podId: 'pod/1',
      attempt: 2,
      containerId: 'container-1',
      containerManager: harness.manager,
      model: 'gpt-5-codex',
      prompt: 'review prompt',
      timeout: 1234,
    });

    expect(beforeLaunch).toHaveBeenCalledWith({
      podId: 'pod/1',
      containerId: 'container-1',
      runtime: 'codex',
      model: 'gpt-5-codex',
    });
    expect(launchGuard).toHaveBeenCalledTimes(1);
    expect(harness.writes).toHaveLength(1);
    expect(harness.writes[0]?.containerId).toBe('container-1');
    expect(harness.writes[0]?.content).toBe('review prompt');
    expect(harness.execs).toHaveLength(2);

    const exec = harness.execs[0];
    expect(exec?.command[0]).toBe('sh');
    expect(exec?.command[1]).toBe('-c');
    expect(exec?.options?.cwd).toBe('/workspace');
    expect(exec?.options?.timeout).toBeGreaterThan(0);
    expect(exec?.options?.timeout).toBeLessThanOrEqual(1234);

    const script = exec?.command[2] ?? '';
    expect(script).toContain('if [ "$status" -ne 0 ]; then\n');
    expect(script).not.toContain('then;');
    expect(script).toContain("--model 'gpt-5-codex'");
    expect(script).toContain('--json');
    expect(script).toContain("< '/tmp/autopod-codex-review-pod_1-2-");
    expect(script).toContain("> '/tmp/autopod-codex-review-pod_1-2-");
    expect(script).toContain("cat '/tmp/autopod-codex-review-pod_1-2-");
  });

  it('uses Codex native output schema files when an output contract is supplied', async () => {
    const harness = createHarness();
    await runCodexReview({
      podId: 'pod-1',
      containerId: 'container-1',
      containerManager: harness.manager,
      model: 'auto',
      prompt: 'review',
      timeout: 1234,
      outputContract: { name: 'review-axis-v1', jsonSchema: '{"type":"object"}' },
    });
    expect(harness.writes).toHaveLength(2);
    expect(harness.writes[1]?.path).toContain('.schema.json');
    expect(harness.execs[0]?.command[2]).toContain('--output-schema');
  });

  it('captures token usage from the Codex JSONL log', async () => {
    const harness = createHarness(
      { stdout: '{"status":"pass"}', stderr: '', exitCode: 0 },
      [
        JSON.stringify({
          type: 'event_msg',
          payload: {
            type: 'token_count',
            info: {
              total_token_usage: {
                input_tokens: 12_345,
                cached_input_tokens: 10_000,
                output_tokens: 678,
              },
            },
          },
        }),
      ].join('\n'),
    );

    const result = await runCodexReview({
      podId: 'pod-1',
      containerId: 'container-1',
      containerManager: harness.manager,
      model: 'gpt-5-codex',
      prompt: 'review prompt',
      timeout: 1234,
    });

    expect(result.tokenUsage).toMatchObject({
      inputTokens: 12_345,
      cachedInputTokens: 10_000,
      outputTokens: 678,
    });
    expect(result.tokenUsage?.costUsd).toBeCloseTo(0.01096125);
    expect(harness.reads[0]?.containerId).toBe('container-1');
    expect(harness.reads[0]?.path).toContain('/tmp/autopod-codex-review-pod-1-0-');
  });

  it('captures public turn.completed usage from wrapped Codex JSONL', async () => {
    const harness = createHarness(
      { stdout: '{"status":"pass"}', stderr: '', exitCode: 0 },
      [
        JSON.stringify({
          type: 'event',
          msg: {
            type: 'turn.completed',
            usage: {
              input_tokens: 20_000,
              cached_input_tokens: 12_000,
              output_tokens: 800,
            },
          },
        }),
      ].join('\n'),
    );

    const result = await runCodexReview({
      podId: 'pod-1',
      containerId: 'container-1',
      containerManager: harness.manager,
      model: 'gpt-5',
      prompt: 'review prompt',
      timeout: 1234,
    });

    expect(result.tokenUsage).toEqual({
      inputTokens: 20_000,
      cachedInputTokens: 12_000,
      outputTokens: 800,
      costUsd: 0.0195,
    });
  });

  it('omits --model when model is auto', async () => {
    const harness = createHarness();

    await runCodexReview({
      podId: 'pod-1',
      containerId: 'container-1',
      containerManager: harness.manager,
      model: 'auto',
      prompt: 'review prompt',
      timeout: 1234,
    });

    expect(harness.execs[0]?.command[2]).not.toContain('--model');
  });

  it('passes reviewer env through to the container exec', async () => {
    const harness = createHarness();

    await runCodexReview({
      podId: 'pod-1',
      containerId: 'container-1',
      containerManager: harness.manager,
      model: 'auto',
      prompt: 'review prompt',
      env: { OPENAI_API_KEY_FILE: '/run/autopod/openai-api-key' },
      timeout: 1234,
    });

    expect(harness.execs[0]?.options).toEqual({
      cwd: '/workspace',
      env: { OPENAI_API_KEY_FILE: '/run/autopod/openai-api-key' },
      timeout: 1234,
    });
  });

  it('uses streaming exec for long-running container reviews when available', async () => {
    const execStreaming = async (
      _containerId: string,
      _command: string[],
      _options?: ExecOptions,
    ): Promise<StreamingExecResult> => ({
      stdout: Readable.from(['{"status":"pass"}']),
      stderr: Readable.from([]),
      exitCode: Promise.resolve(0),
      kill: async () => {},
    });
    const manager = {
      supportsStreamingExec: true,
      writeFile: async () => {},
      readFile: async () => '',
      execInContainer: async () => {
        throw new Error('buffered exec should not be used');
      },
      execStreaming,
    } as unknown as ContainerManager;

    const result = await runCodexReview({
      podId: 'sandbox-pod',
      containerId: 'sandbox-1',
      containerManager: manager,
      model: 'gpt-5',
      prompt: 'review prompt',
      timeout: 300_000,
    });

    expect(result.stdout).toBe('{"status":"pass"}');
  });

  it.each([0, 30, 120])(
    'waits for process exit within the deadline after %sms streaming launch',
    async (launchDelay) => {
      vi.useFakeTimers({ toFake: ['performance', 'setTimeout', 'clearTimeout'] });
      try {
        let confirmExit: ((code: number) => void) | undefined;
        const exitCode = new Promise<number>((resolve) => {
          confirmExit = resolve;
        });
        const kill = vi.fn().mockResolvedValue(undefined);
        const manager = {
          supportsStreamingExec: true,
          writeFile: async () => {},
          readFile: async () => '',
          execInContainer: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
          execStreaming: async () => {
            if (launchDelay) await new Promise<void>((resolve) => setTimeout(resolve, launchDelay));
            return {
              stdout: Readable.from([]),
              stderr: Readable.from([]),
              exitCode,
              kill,
            };
          },
        } as unknown as ContainerManager;

        const review = runCodexReview({
          podId: 'sandbox-pod',
          containerId: 'sandbox-1',
          containerManager: manager,
          model: 'gpt-5',
          prompt: 'review prompt',
          timeout: 100,
          beforeLaunch: async () => () => {},
        });
        await vi.advanceTimersByTimeAsync(Math.max(100, launchDelay) + 1);
        expect(kill).toHaveBeenCalledOnce();
        let settled = false;
        void review.then(
          () => {
            settled = true;
          },
          () => {
            settled = true;
          },
        );
        await Promise.resolve();
        expect(settled).toBe(false);

        confirmExit?.(137);
        await expect(review).rejects.toMatchObject({ kind: 'timeout' });
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it('throws a CodexReviewError when the in-container review command fails', async () => {
    const harness = createHarness({
      stdout: 'codex review failed (exit 2)\nsh: 1: Syntax error: ";" unexpected',
      stderr: '',
      exitCode: 2,
    });

    await expect(
      runCodexReview({
        podId: 'pod-1',
        containerId: 'container-1',
        containerManager: harness.manager,
        model: 'auto',
        prompt: 'review prompt',
        timeout: 1234,
      }),
    ).rejects.toMatchObject({
      name: 'CodexReviewError',
      kind: 'non-zero-exit',
      exitCode: 2,
    });
  });

  it('preserves bounded invalid schema classification for the batch boundary', async () => {
    const warn = vi.fn();
    const harness = createHarness({
      stdout: 'codex review failed (exit 1)\ninvalid_json_schema private provider diagnostic',
      stderr: '',
      exitCode: 1,
    });

    await expect(
      runCodexReview({
        podId: 'pod-1',
        containerId: 'container-1',
        containerManager: harness.manager,
        model: 'gpt-5.6-sol',
        prompt: 'review prompt',
        timeout: 1234,
        logger: { warn } as never,
      }),
    ).rejects.toMatchObject({
      name: 'CodexReviewError',
      kind: 'schema-invalid',
      message: 'codex review rejected the configured output schema',
    });
    expect(warn).toHaveBeenCalledWith(
      { reviewerDiagnostic: 'INVALID_OUTPUT_SCHEMA', exitCode: 1 },
      'codex reviewer rejected output schema',
    );
    expect(JSON.stringify(warn.mock.calls)).not.toContain('private provider diagnostic');
  });
});
