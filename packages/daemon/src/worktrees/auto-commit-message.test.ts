import type { ChildProcess } from 'node:child_process';
import type { Profile } from '@autopod/shared';
import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildHeuristicMessage, generateAutoCommitMessage } from './auto-commit-message.js';

const logger = pino({ level: 'silent' });

const { execFileMock, anthropicCreateMock, anthropicCtorMock } = vi.hoisted(() => ({
  execFileMock: vi.fn(),
  anthropicCreateMock: vi.fn(),
  anthropicCtorMock: vi.fn(),
}));

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  return { ...actual, execFile: execFileMock };
});

vi.mock('@anthropic-ai/sdk', () => {
  const Anthropic = vi.fn().mockImplementation((opts: unknown) => {
    anthropicCtorMock(opts);
    return { messages: { create: anthropicCreateMock } };
  });
  return { default: Anthropic };
});

type ExecCallback = (error: Error | null, result: unknown, stderr?: string) => void;

function resolveCallback(arg3: unknown, arg4: unknown): ExecCallback {
  if (typeof arg4 === 'function') return arg4 as ExecCallback;
  if (typeof arg3 === 'function') return arg3 as ExecCallback;
  throw new Error('No callback found in execFile arguments');
}

const STAT_OUTPUT = [
  ' src/foo.ts | 12 ++++++++----',
  ' src/bar.ts |  3 +++',
  ' src/baz.ts |  1 +',
  ' 3 files changed, 14 insertions(+), 2 deletions(-)',
  '',
].join('\n');

const DIFF_OUTPUT = `diff --git a/src/foo.ts b/src/foo.ts
+const x = 1;
-const x = 0;
`;

function setupExec(opts: { stat?: string; diff?: string; statError?: Error; diffError?: Error }) {
  execFileMock.mockImplementation(
    (_file: string, args: string[], arg3: unknown, arg4?: unknown) => {
      const cb = resolveCallback(arg3, arg4);
      const cmd = args.join(' ');
      if (cmd.includes('--stat')) {
        if (opts.statError) {
          cb(opts.statError, { stdout: '', stderr: '' });
        } else {
          cb(null, { stdout: opts.stat ?? STAT_OUTPUT, stderr: '' });
        }
      } else if (cmd.includes('diff --cached')) {
        if (opts.diffError) {
          cb(opts.diffError, { stdout: '', stderr: '' });
        } else {
          cb(null, { stdout: opts.diff ?? DIFF_OUTPUT, stderr: '' });
        }
      } else {
        cb(null, { stdout: '', stderr: '' });
      }
      return {} as ChildProcess;
    },
  );
}

const SAMPLE_PROFILE = {
  name: 'test-profile',
  modelProvider: 'max',
  providerCredentials: { provider: 'max' },
  reviewerModel: null,
  defaultModel: null,
} as unknown as Profile;

const baseInput = {
  worktreePath: '/tmp/wt',
  podTask: 'task',
  profile: SAMPLE_PROFILE,
  podModel: 'haiku',
};

describe('generateAutoCommitMessage', () => {
  beforeEach(() => {
    execFileMock.mockReset();
    anthropicCreateMock.mockReset();
    anthropicCtorMock.mockReset();
    process.env.ANTHROPIC_API_KEY = 'test-key';
  });

  afterEach(() => {
    delete process.env.ANTHROPIC_API_KEY;
  });

  it('returns the model output verbatim on a successful call', async () => {
    setupExec({});
    anthropicCreateMock.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'feat: add foo helper' }],
    });

    const result = await generateAutoCommitMessage(
      { ...baseInput, podTask: 'add foo helper' },
      logger,
    );
    expect(result.message).toBe('feat: add foo helper');
    expect(result.usedFallback).toBe(false);
    expect(result.fallbackReason).toBeUndefined();
    expect(anthropicCreateMock).toHaveBeenCalledOnce();
  });

  it('falls back to heuristic when the API call throws (api_call_failed)', async () => {
    setupExec({});
    anthropicCreateMock.mockRejectedValueOnce(new Error('429 rate limited'));

    const result = await generateAutoCommitMessage(baseInput, logger);
    expect(result.message).toBe('chore: auto-commit updates to foo.ts, bar.ts, baz.ts (+14 -2)');
    expect(result.usedFallback).toBe(true);
    expect(result.fallbackReason).toBe('api_call_failed');
    expect(result.fallbackDetail).toContain('429');
  });

  it('skips the API call entirely when ANTHROPIC_API_KEY is unset (no_anthropic_api_key)', async () => {
    delete process.env.ANTHROPIC_API_KEY;
    setupExec({});

    const result = await generateAutoCommitMessage(baseInput, logger);
    expect(result.message).toBe('chore: auto-commit updates to foo.ts, bar.ts, baz.ts (+14 -2)');
    expect(result.usedFallback).toBe(true);
    expect(result.fallbackReason).toBe('no_anthropic_api_key');
    expect(anthropicCreateMock).not.toHaveBeenCalled();
  });

  it('rejects model output that contains newlines and falls back (output_invalid)', async () => {
    setupExec({});
    anthropicCreateMock.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'feat: add foo helper\n\nThis is a body' }],
    });

    const result = await generateAutoCommitMessage(baseInput, logger);
    expect(result.message).toBe('chore: auto-commit updates to foo.ts, bar.ts, baz.ts (+14 -2)');
    expect(result.usedFallback).toBe(true);
    expect(result.fallbackReason).toBe('output_invalid');
  });

  it('rejects model output longer than 100 chars and falls back (output_invalid)', async () => {
    setupExec({});
    anthropicCreateMock.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'feat: '.padEnd(120, 'x') }],
    });

    const result = await generateAutoCommitMessage(baseInput, logger);
    expect(result.message).toBe('chore: auto-commit updates to foo.ts, bar.ts, baz.ts (+14 -2)');
    expect(result.usedFallback).toBe(true);
    expect(result.fallbackReason).toBe('output_invalid');
  });

  it('returns the hardcoded message when git stat itself fails (git_stat_failed)', async () => {
    setupExec({ statError: new Error('not a git repo') });

    const result = await generateAutoCommitMessage(baseInput, logger);
    expect(result.message).toBe('chore: auto-commit uncommitted agent changes');
    expect(result.usedFallback).toBe(true);
    expect(result.fallbackReason).toBe('git_stat_failed');
    expect(anthropicCreateMock).not.toHaveBeenCalled();
  });

  it('falls back to heuristic when reading the full diff fails (git_diff_failed)', async () => {
    setupExec({ diffError: new Error('diff broke') });

    const result = await generateAutoCommitMessage(baseInput, logger);
    expect(result.message).toBe('chore: auto-commit updates to foo.ts, bar.ts, baz.ts (+14 -2)');
    expect(result.usedFallback).toBe(true);
    expect(result.fallbackReason).toBe('git_diff_failed');
    expect(anthropicCreateMock).not.toHaveBeenCalled();
  });

  it('instantiates the Anthropic SDK with the host env var', async () => {
    setupExec({});
    anthropicCreateMock.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'feat: ok' }],
    });

    await generateAutoCommitMessage(baseInput, logger);
    expect(anthropicCtorMock).toHaveBeenCalledWith({ apiKey: 'test-key' });
  });
});

describe('buildHeuristicMessage', () => {
  it('summarizes a typical stat with three top files and counts', () => {
    expect(buildHeuristicMessage(STAT_OUTPUT)).toBe(
      'chore: auto-commit updates to foo.ts, bar.ts, baz.ts (+14 -2)',
    );
  });

  it('reports "+N more" when more than three files are touched', () => {
    const stat = [
      ' a.ts | 1 +',
      ' b.ts | 1 +',
      ' c.ts | 1 +',
      ' d.ts | 1 +',
      ' e.ts | 1 +',
      ' 5 files changed, 5 insertions(+)',
    ].join('\n');
    expect(buildHeuristicMessage(stat)).toBe(
      'chore: auto-commit updates to a.ts, b.ts, c.ts (+2 more) (+5 -0)',
    );
  });

  it('strips path prefixes leaving only basenames', () => {
    const stat = [
      ' packages/daemon/src/pods/pod-manager.ts | 4 ++--',
      ' 1 file changed, 2 insertions(+), 2 deletions(-)',
    ].join('\n');
    expect(buildHeuristicMessage(stat)).toBe(
      'chore: auto-commit updates to pod-manager.ts (+2 -2)',
    );
  });

  it('falls back to the generic message on empty stat', () => {
    expect(buildHeuristicMessage('')).toBe('chore: auto-commit uncommitted agent changes');
  });
});
