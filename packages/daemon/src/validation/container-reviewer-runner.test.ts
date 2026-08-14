import { PassThrough } from 'node:stream';
import type { Profile } from '@autopod/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ContainerManager } from '../interfaces/container-manager.js';
import {
  ContainerReviewerUnavailableError,
  resolveContainerReviewer,
  runContainerReviewer,
} from './container-reviewer-runner.js';
import { runCodexReview } from './review-codex-runner.js';
import { reviewAxisOutputContract } from './review-structured-output.js';

vi.mock('./review-codex-runner.js', () => ({
  runCodexReview: vi.fn(),
}));

const mockRunCodexReview = vi.mocked(runCodexReview);

function profile(overrides: Partial<Profile>): Profile {
  return {
    name: 'proj',
    repoUrl: 'https://example.com/repo.git',
    baseBranch: 'main',
    modelProvider: 'anthropic',
    providerCredentials: { provider: 'anthropic' },
    defaultModel: 'sonnet',
    defaultRuntime: 'claude',
    ...overrides,
  } as Profile;
}

function containerManager(
  execResult = { stdout: 'review output\n', stderr: '', exitCode: 0 },
): ContainerManager {
  const execStreaming = vi.fn().mockImplementation(async () => {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    stdout.end(execResult.stdout);
    stderr.end(execResult.stderr);
    return {
      stdout,
      stderr,
      exitCode: Promise.resolve(execResult.exitCode),
      kill: vi.fn().mockResolvedValue(undefined),
    };
  });
  return {
    writeFile: vi.fn().mockResolvedValue(undefined),
    readFile: vi.fn().mockResolvedValue(''),
    execInContainer: vi.fn().mockResolvedValue(execResult),
    execStreaming,
    supportsStreamingExec: true,
    getStatus: vi.fn().mockResolvedValue('running' as const),
  } as unknown as ContainerManager;
}

describe('resolveContainerReviewer', () => {
  it('routes OpenAI-surface profiles to Codex and Anthropic-compatible profiles to Claude', () => {
    expect(resolveContainerReviewer(profile({ modelProvider: 'openai' }))).toBe('codex');
    expect(
      resolveContainerReviewer(
        profile({
          modelProvider: 'foundry',
          providerCredentials: {
            provider: 'foundry',
            endpoint: 'https://foundry.example',
            projectId: 'proj',
            apiSurface: 'openai',
          },
        }),
      ),
    ).toBe('codex');
    expect(resolveContainerReviewer(profile({ modelProvider: 'max' }))).toBe('claude');
    expect(
      resolveContainerReviewer(
        profile({
          modelProvider: 'foundry',
          providerCredentials: {
            provider: 'foundry',
            endpoint: 'https://foundry.example',
            projectId: 'proj',
            apiSurface: 'anthropic',
          },
        }),
      ),
    ).toBe('claude');
    expect(resolveContainerReviewer(profile({ modelProvider: 'anthropic' }))).toBe('claude');
    expect(resolveContainerReviewer(profile({ modelProvider: null }))).toBe('claude');
  });

  it('marks providers without a live container reviewer path as unavailable', () => {
    expect(resolveContainerReviewer(profile({ modelProvider: 'copilot' }))).toEqual({
      provider: 'copilot',
    });
    expect(resolveContainerReviewer(profile({ modelProvider: 'pi' }))).toEqual({
      provider: 'pi',
    });
  });
});

describe('runContainerReviewer', () => {
  beforeEach(() => {
    mockRunCodexReview.mockReset();
  });

  it('runs Claude CLI in the live pod container for Anthropic-compatible profiles', async () => {
    const cm = containerManager({
      stdout: JSON.stringify({
        result: 'review output\n',
        usage: {
          input_tokens: 4321,
          cache_read_input_tokens: 3000,
          output_tokens: 123,
        },
        total_cost_usd: 0.045,
      }),
      stderr: '',
      exitCode: 0,
    });

    const result = await runContainerReviewer({
      podId: 'sess-1',
      containerId: 'container-abc',
      containerManager: cm,
      profile: profile({ modelProvider: 'max' }),
      model: 'sonnet',
      prompt: 'Generate script',
      env: { ANTHROPIC_API_KEY_FILE: '/run/autopod/anthropic-api-key' },
      timeout: 60_000,
    });

    expect(result.stdout).toBe('review output\n');
    expect(result.tokenUsage).toEqual({
      inputTokens: 7321,
      cachedInputTokens: 3000,
      outputTokens: 123,
      costUsd: 0.045,
    });
    expect(cm.writeFile).toHaveBeenCalledWith(
      'container-abc',
      expect.stringContaining('/tmp/autopod-claude-review-sess-1-'),
      'Generate script',
    );
    expect(cm.execStreaming).toHaveBeenCalledWith(
      'container-abc',
      ['sh', '-c', expect.stringContaining("sh '/run/autopod/agent-shim.sh' claude -p")],
      expect.objectContaining({
        cwd: '/workspace',
        env: { ANTHROPIC_API_KEY_FILE: '/run/autopod/anthropic-api-key' },
      }),
    );
    expect(vi.mocked(cm.execStreaming).mock.calls[0]?.[2]).not.toHaveProperty('timeout');
    expect((cm.execStreaming as ReturnType<typeof vi.fn>).mock.calls[0]?.[1][2]).toContain(
      '--output-format json',
    );
    expect((cm.execStreaming as ReturnType<typeof vi.fn>).mock.calls[0]?.[1][2]).toContain(
      "--tools ''",
    );
    expect((cm.execStreaming as ReturnType<typeof vi.fn>).mock.calls[0]?.[1][2]).toContain(
      '--disable-slash-commands',
    );
    expect((cm.execStreaming as ReturnType<typeof vi.fn>).mock.calls[0]?.[1][2]).toContain(
      '--no-session-persistence',
    );
    expect(cm.execInContainer).not.toHaveBeenCalledWith(
      'container-abc',
      ['sh', '-c', expect.any(String)],
      expect.any(Object),
    );
    expect(mockRunCodexReview).not.toHaveBeenCalled();
  });

  it('uses Claude native JSON schema files when an output contract is supplied', async () => {
    const cm = containerManager({
      stdout: JSON.stringify({ result: 'ok' }),
      stderr: '',
      exitCode: 0,
    });
    await runContainerReviewer({
      podId: 'sess-1',
      containerId: 'container-abc',
      containerManager: cm,
      profile: profile({ modelProvider: 'max' }),
      model: 'sonnet',
      prompt: 'review',
      timeout: 60_000,
      outputContract: { name: 'review-axis-v1', jsonSchema: '{"type":"object"}' },
    });
    expect(cm.writeFile).toHaveBeenCalledTimes(1);
    expect((cm.execStreaming as ReturnType<typeof vi.fn>).mock.calls[0]?.[1][2]).toContain(
      '--json-schema',
    );
  });

  it('passes provider-compatible inline schema to Claude', async () => {
    const cm = containerManager({
      stdout: JSON.stringify({ result: '{"findings":[]}' }),
      stderr: '',
      exitCode: 0,
    });
    await runContainerReviewer({
      podId: 'sess-1',
      containerId: 'container-abc',
      containerManager: cm,
      profile: profile({ modelProvider: 'max' }),
      model: 'sonnet',
      prompt: 'review',
      timeout: 60_000,
      outputContract: reviewAxisOutputContract,
    });
    const command = (cm.execStreaming as ReturnType<typeof vi.fn>).mock.calls[0]?.[1][2];
    expect(command).toContain(`--json-schema '${reviewAxisOutputContract.jsonSchema}'`);
    expect(cm.writeFile).toHaveBeenCalledTimes(1);
  });

  it('classifies Claude output-schema rejection without retaining raw diagnostics', async () => {
    const cm = containerManager({
      stdout: 'invalid_json_schema private provider diagnostic',
      stderr: '',
      exitCode: 1,
    });
    const warn = vi.fn();
    await expect(
      runContainerReviewer({
        podId: 'sess-1',
        containerId: 'container-abc',
        containerManager: cm,
        profile: profile({ modelProvider: 'max' }),
        model: 'sonnet',
        prompt: 'review',
        timeout: 60_000,
        outputContract: reviewAxisOutputContract,
        logger: { info: vi.fn(), warn } as never,
      }),
    ).rejects.toMatchObject({
      kind: 'schema-invalid',
      message: 'Container reviewer rejected the configured output schema',
    });
    expect(warn).toHaveBeenCalledWith(
      { reviewerDiagnostic: 'INVALID_OUTPUT_SCHEMA', exitCode: 1 },
      'claude reviewer rejected output schema',
    );
    expect(JSON.stringify(warn.mock.calls)).not.toContain('private provider diagnostic');
  });

  it('runs Codex CLI in the live pod container for OpenAI-surface profiles', async () => {
    mockRunCodexReview.mockResolvedValueOnce({ stdout: 'codex output' });
    const cm = containerManager();

    const result = await runContainerReviewer({
      podId: 'sess-1',
      containerId: 'container-abc',
      containerManager: cm,
      profile: profile({ modelProvider: 'openai' }),
      model: 'gpt-5',
      prompt: 'Generate script',
      env: { OPENAI_API_KEY_FILE: '/run/autopod/openai-api-key' },
      timeout: 60_000,
    });

    expect(result.stdout).toBe('codex output');
    expect(mockRunCodexReview).toHaveBeenCalledWith(
      expect.objectContaining({
        podId: 'sess-1',
        containerId: 'container-abc',
        containerManager: cm,
        model: 'gpt-5',
        prompt: 'Generate script',
        env: { OPENAI_API_KEY_FILE: '/run/autopod/openai-api-key' },
      }),
    );
  });

  it('fails clearly when no live container is available', async () => {
    await expect(
      runContainerReviewer({
        podId: 'sess-1',
        containerId: null,
        containerManager: containerManager(),
        profile: profile({ modelProvider: 'max' }),
        model: 'sonnet',
        prompt: 'Generate script',
        timeout: 60_000,
      }),
    ).rejects.toThrow(ContainerReviewerUnavailableError);
  });

  it('attempts the review when the sandbox status probe is transiently unknown', async () => {
    mockRunCodexReview.mockResolvedValueOnce({ stdout: '{"selected":[]}' });
    const cm = containerManager();
    vi.mocked(cm.getStatus).mockResolvedValue('unknown');

    await expect(
      runContainerReviewer({
        podId: 'sess-1',
        containerId: 'container-abc',
        containerManager: cm,
        profile: profile({ modelProvider: 'openai' }),
        model: 'auto',
        prompt: 'Rank memory',
        timeout: 20_000,
      }),
    ).resolves.toEqual({ stdout: '{"selected":[]}' });
    expect(mockRunCodexReview).toHaveBeenCalledOnce();
  });

  it('terminates timed-out Claude container reviews', async () => {
    vi.useFakeTimers();
    try {
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      let confirmExit: ((code: number) => void) | undefined;
      const exitCode = new Promise<number>((resolve) => {
        confirmExit = resolve;
      });
      const kill = vi.fn().mockImplementation(async () => {
        stdout.end();
        stderr.end();
        confirmExit?.(143);
      });
      const cm = containerManager();
      vi.mocked(cm.readFile).mockResolvedValue(
        `${'staged-'.repeat(1_000)}bounded staged diagnostic`,
      );
      vi.mocked(cm.execStreaming).mockResolvedValue({
        stdout,
        stderr,
        exitCode,
        kill,
      });

      const review = runContainerReviewer({
        podId: 'tame-dingo',
        containerId: 'container-abc',
        containerManager: cm,
        profile: profile({ modelProvider: 'max' }),
        model: 'sonnet',
        prompt: 'Review without leaking this prompt into argv',
        timeout: 90_000,
      }).catch((error: unknown) => error);
      stdout.write('x'.repeat(6_000));
      stderr.write('bounded diagnostic');
      await vi.advanceTimersByTimeAsync(90_000);

      const error = await review;
      expect(error).toMatchObject({
        name: 'ContainerReviewerUnavailableError',
        kind: 'timeout',
        stderr: expect.stringContaining('bounded staged diagnostic'),
      });
      expect(error).toBeInstanceOf(ContainerReviewerUnavailableError);
      expect((error as Error).message).toMatch(/timed out after 90000ms/);
      expect((error as Error).message).not.toMatch(/x{4001}/);
      expect((error as Error).message.length).toBeLessThan(4_100);
      expect(kill).toHaveBeenCalledOnce();
      expect(cm.execInContainer).not.toHaveBeenCalledWith(
        'container-abc',
        ['sh', '-c', expect.any(String)],
        expect.any(Object),
      );
      expect(cm.readFile).toHaveBeenCalledWith(
        'container-abc',
        expect.stringContaining('/tmp/autopod-claude-review-tame-dingo-'),
      );
      expect(vi.mocked(cm.execStreaming).mock.calls[0]?.[1]).not.toContain(
        'Review without leaking this prompt into argv',
      );
      expect(vi.mocked(cm.execStreaming).mock.calls[0]?.[2]).not.toHaveProperty('timeout');

      const unconfirmed = containerManager();
      const unconfirmedStdout = new PassThrough();
      const unconfirmedStderr = new PassThrough();
      vi.mocked(unconfirmed.execStreaming).mockResolvedValue({
        stdout: unconfirmedStdout,
        stderr: unconfirmedStderr,
        exitCode: new Promise<number>(() => {}),
        kill: vi.fn().mockRejectedValue(new Error('termination transport failed')),
      });
      const failedCancellation = runContainerReviewer({
        podId: 'tame-dingo',
        containerId: 'container-abc',
        containerManager: unconfirmed,
        profile: profile({ modelProvider: 'max' }),
        model: 'sonnet',
        prompt: 'Review',
        timeout: 90_000,
      }).catch((failure: unknown) => failure);
      await vi.advanceTimersByTimeAsync(90_000);
      await expect(failedCancellation).resolves.toMatchObject({
        kind: 'termination-failed',
        message: expect.stringContaining('remote termination could not be confirmed'),
      });

      const missingExit = containerManager();
      const missingExitStdout = new PassThrough();
      const missingExitStderr = new PassThrough();
      vi.mocked(missingExit.execStreaming).mockResolvedValue({
        stdout: missingExitStdout,
        stderr: missingExitStderr,
        exitCode: new Promise<number>(() => {}),
        kill: vi.fn().mockResolvedValue(undefined),
      });
      const missingConfirmation = runContainerReviewer({
        podId: 'tame-dingo',
        containerId: 'container-abc',
        containerManager: missingExit,
        profile: profile({ modelProvider: 'max' }),
        model: 'sonnet',
        prompt: 'Review',
        timeout: 90_000,
      }).catch((failure: unknown) => failure);
      await vi.advanceTimersByTimeAsync(95_000);
      await expect(missingConfirmation).resolves.toMatchObject({
        kind: 'termination-failed',
        message: expect.stringContaining('remote termination could not be confirmed'),
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('classifies deadline-triggered process exit as a timeout', async () => {
    vi.useFakeTimers();
    try {
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      let confirmExit: ((code: number) => void) | undefined;
      let finishKill: (() => void) | undefined;
      const exitCode = new Promise<number>((resolve) => {
        confirmExit = resolve;
      });
      const kill = vi.fn().mockImplementation(async () => {
        stdout.end();
        stderr.end('setsid: child 120966 did not exit normally: Success');
        confirmExit?.(15);
        await new Promise<void>((resolve) => {
          finishKill = resolve;
        });
      });
      const cm = containerManager();
      vi.mocked(cm.execStreaming).mockResolvedValue({ stdout, stderr, exitCode, kill });

      const review = runContainerReviewer({
        podId: 'emotional-tahr',
        containerId: 'container-abc',
        containerManager: cm,
        profile: profile({ modelProvider: 'max' }),
        model: 'sonnet',
        prompt: 'Review',
        timeout: 300_000,
      }).catch((failure: unknown) => failure);

      await vi.advanceTimersByTimeAsync(300_000);
      await Promise.resolve();
      finishKill?.();

      await expect(review).resolves.toMatchObject({
        kind: 'timeout',
        message: expect.stringContaining('timed out after 300000ms'),
      });
      expect(kill).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });
});
