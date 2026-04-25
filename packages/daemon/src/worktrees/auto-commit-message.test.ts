import type { ChildProcess } from 'node:child_process';
import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildHeuristicMessage, generateAutoCommitMessage } from './auto-commit-message.js';

const logger = pino({ level: 'silent' });

const { execFileMock, anthropicCreateMock } = vi.hoisted(() => ({
  execFileMock: vi.fn(),
  anthropicCreateMock: vi.fn(),
}));

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  return { ...actual, execFile: execFileMock };
});

vi.mock('@anthropic-ai/sdk', () => {
  return {
    default: vi.fn().mockImplementation(() => ({
      messages: { create: anthropicCreateMock },
    })),
  };
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

describe('generateAutoCommitMessage', () => {
  const originalKey = process.env.ANTHROPIC_API_KEY;

  beforeEach(() => {
    execFileMock.mockReset();
    anthropicCreateMock.mockReset();
  });

  afterEach(() => {
    if (originalKey === undefined) {
      // biome-ignore lint/performance/noDelete: assigning undefined to process.env coerces to the string "undefined"
      delete process.env.ANTHROPIC_API_KEY;
    } else {
      process.env.ANTHROPIC_API_KEY = originalKey;
    }
  });

  it('returns the model output verbatim on a successful Haiku call', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-test';
    setupExec({});
    anthropicCreateMock.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'feat: add foo helper' }],
    });

    const msg = await generateAutoCommitMessage('/tmp/wt', 'add foo helper', logger);
    expect(msg).toBe('feat: add foo helper');
    expect(anthropicCreateMock).toHaveBeenCalledOnce();
  });

  it('falls back to heuristic when the API call throws', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-test';
    setupExec({});
    anthropicCreateMock.mockRejectedValueOnce(new Error('429 rate limited'));

    const msg = await generateAutoCommitMessage('/tmp/wt', 'task', logger);
    expect(msg).toBe('chore: auto-commit updates to foo.ts, bar.ts, baz.ts (+14 -2)');
  });

  it('skips the API call entirely when ANTHROPIC_API_KEY is unset', async () => {
    // biome-ignore lint/performance/noDelete: assigning undefined to process.env coerces to the string "undefined"
    delete process.env.ANTHROPIC_API_KEY;
    setupExec({});

    const msg = await generateAutoCommitMessage('/tmp/wt', 'task', logger);
    expect(msg).toBe('chore: auto-commit updates to foo.ts, bar.ts, baz.ts (+14 -2)');
    expect(anthropicCreateMock).not.toHaveBeenCalled();
  });

  it('rejects model output that contains newlines and falls back to heuristic', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-test';
    setupExec({});
    anthropicCreateMock.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'feat: add foo helper\n\nThis is a body' }],
    });

    const msg = await generateAutoCommitMessage('/tmp/wt', 'task', logger);
    expect(msg).toBe('chore: auto-commit updates to foo.ts, bar.ts, baz.ts (+14 -2)');
  });

  it('rejects model output longer than 100 chars and falls back to heuristic', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-test';
    setupExec({});
    anthropicCreateMock.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'feat: '.padEnd(120, 'x') }],
    });

    const msg = await generateAutoCommitMessage('/tmp/wt', 'task', logger);
    expect(msg).toBe('chore: auto-commit updates to foo.ts, bar.ts, baz.ts (+14 -2)');
  });

  it('returns the original hardcoded message when git stat itself fails', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-test';
    setupExec({ statError: new Error('not a git repo') });

    const msg = await generateAutoCommitMessage('/tmp/wt', 'task', logger);
    expect(msg).toBe('chore: auto-commit uncommitted agent changes');
    expect(anthropicCreateMock).not.toHaveBeenCalled();
  });

  it('falls back to heuristic when reading the full diff fails', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-test';
    setupExec({ diffError: new Error('diff broke') });

    const msg = await generateAutoCommitMessage('/tmp/wt', 'task', logger);
    expect(msg).toBe('chore: auto-commit updates to foo.ts, bar.ts, baz.ts (+14 -2)');
    expect(anthropicCreateMock).not.toHaveBeenCalled();
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
