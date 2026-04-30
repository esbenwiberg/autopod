import type { ChildProcess } from 'node:child_process';
import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { generatePrNarrative, generatePrTitle } from './pr-description-generator.js';

const logger = pino({ level: 'silent' });

const { execFileMock, anthropicCreateMock } = vi.hoisted(() => ({
  execFileMock: vi.fn(),
  anthropicCreateMock: vi.fn(),
}));

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  return { ...actual, execFile: execFileMock };
});

vi.mock('@anthropic-ai/sdk', () => ({
  default: vi.fn().mockImplementation(() => ({
    messages: { create: anthropicCreateMock },
  })),
}));

type ExecCallback = (error: Error | null, result: unknown) => void;

function setupDiffExec(diff: string, error?: Error) {
  execFileMock.mockImplementation(
    (_file: string, _args: string[], arg3: unknown, arg4?: unknown) => {
      const cb = (typeof arg4 === 'function' ? arg4 : arg3) as ExecCallback;
      if (error) {
        cb(error, { stdout: '', stderr: '' });
      } else {
        cb(null, { stdout: diff, stderr: '' });
      }
      return {} as ChildProcess;
    },
  );
}

const SAMPLE_DIFF = `diff --git a/src/auth/token-manager.ts b/src/auth/token-manager.ts
+  async refreshToken() { ... }
-  async getToken() { ... }
`;

const baseInput = {
  task: 'Add MSAL token refresh to prevent session expiry',
  worktreePath: '/tmp/wt',
  baseBranch: 'main',
  filesChanged: 3,
  linesAdded: 80,
  linesRemoved: 20,
};

describe('generatePrTitle', () => {
  const originalKey = process.env.ANTHROPIC_API_KEY;

  beforeEach(() => {
    execFileMock.mockReset();
    anthropicCreateMock.mockReset();
  });

  afterEach(() => {
    if (originalKey === undefined) {
      // biome-ignore lint/performance/noDelete: assigning undefined coerces to "undefined"
      delete process.env.ANTHROPIC_API_KEY;
    } else {
      process.env.ANTHROPIC_API_KEY = originalKey;
    }
  });

  it('returns LLM title on a successful call', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-test';
    setupDiffExec(SAMPLE_DIFF);
    anthropicCreateMock.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'feat(auth): add MSAL proactive token refresh' }],
    });

    const title = await generatePrTitle(baseInput, logger);
    expect(title).toBe('feat(auth): add MSAL proactive token refresh');
    expect(anthropicCreateMock).toHaveBeenCalledOnce();
  });

  it('falls back to buildPrTitle when API key is absent', async () => {
    // biome-ignore lint/performance/noDelete: assigning undefined coerces to "undefined"
    delete process.env.ANTHROPIC_API_KEY;
    setupDiffExec(SAMPLE_DIFF);

    const title = await generatePrTitle(baseInput, logger);
    expect(title).toContain('feat:');
    expect(anthropicCreateMock).not.toHaveBeenCalled();
  });

  it('falls back when LLM returns a title over 72 chars', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-test';
    setupDiffExec(SAMPLE_DIFF);
    anthropicCreateMock.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'feat(auth): '.padEnd(80, 'x') }],
    });

    const title = await generatePrTitle(baseInput, logger);
    // Falls back to buildPrTitle which truncates to ≤70 chars
    expect(title.length).toBeLessThanOrEqual(70);
  });

  it('falls back when LLM title contains newlines', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-test';
    setupDiffExec(SAMPLE_DIFF);
    anthropicCreateMock.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'feat: add token refresh\n\nextra body' }],
    });

    const title = await generatePrTitle(baseInput, logger);
    expect(title).not.toContain('\n');
  });

  it('falls back on API error', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-test';
    setupDiffExec(SAMPLE_DIFF);
    anthropicCreateMock.mockRejectedValueOnce(new Error('503 service unavailable'));

    const title = await generatePrTitle(baseInput, logger);
    expect(title).toContain('feat:');
  });
});

describe('generatePrNarrative', () => {
  const originalKey = process.env.ANTHROPIC_API_KEY;

  const validNarrativeJson = JSON.stringify({
    why: 'Sessions were silently expiring after 30 minutes.',
    what: 'Added proactive token refresh with a 5-minute expiry window in token-manager.ts.',
    how: 'Used MSAL acquireTokenSilent with a custom expiry check.',
    reviewFocus: ['packages/cli/src/auth/token-manager.ts'],
  });

  beforeEach(() => {
    execFileMock.mockReset();
    anthropicCreateMock.mockReset();
  });

  afterEach(() => {
    if (originalKey === undefined) {
      // biome-ignore lint/performance/noDelete: assigning undefined coerces to "undefined"
      delete process.env.ANTHROPIC_API_KEY;
    } else {
      process.env.ANTHROPIC_API_KEY = originalKey;
    }
  });

  it('returns parsed narrative on a successful LLM call', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-test';
    setupDiffExec(SAMPLE_DIFF);
    anthropicCreateMock.mockResolvedValueOnce({
      content: [{ type: 'text', text: validNarrativeJson }],
    });

    const result = await generatePrNarrative(baseInput, logger);
    expect(result.why).toBe('Sessions were silently expiring after 30 minutes.');
    expect(result.what).toContain('proactive token refresh');
    expect(result.how).toContain('acquireTokenSilent');
    expect(result.reviewFocus).toEqual(['packages/cli/src/auth/token-manager.ts']);
  });

  it('falls back to plain taskSummary when API key is absent', async () => {
    // biome-ignore lint/performance/noDelete: assigning undefined coerces to "undefined"
    delete process.env.ANTHROPIC_API_KEY;
    setupDiffExec(SAMPLE_DIFF);

    const result = await generatePrNarrative(
      { ...baseInput, taskSummary: { actualSummary: 'Did the thing.', deviations: [] } },
      logger,
    );
    expect(result.why).toBe(baseInput.task);
    expect(result.what).toBe('Did the thing.');
    expect(anthropicCreateMock).not.toHaveBeenCalled();
  });

  it('falls back on invalid JSON response', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-test';
    setupDiffExec(SAMPLE_DIFF);
    anthropicCreateMock.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'Here is your narrative: sorry not json' }],
    });

    const result = await generatePrNarrative(baseInput, logger);
    expect(result.why).toBe(baseInput.task);
    expect(result.reviewFocus).toBeUndefined();
  });

  it('strips markdown code fences from LLM output before parsing', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-test';
    setupDiffExec(SAMPLE_DIFF);
    anthropicCreateMock.mockResolvedValueOnce({
      content: [{ type: 'text', text: '```json\n' + validNarrativeJson + '\n```' }],
    });

    const result = await generatePrNarrative(baseInput, logger);
    expect(result.why).toBe('Sessions were silently expiring after 30 minutes.');
  });

  it('falls back on API error', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-test';
    setupDiffExec(SAMPLE_DIFF);
    anthropicCreateMock.mockRejectedValueOnce(new Error('timeout'));

    const result = await generatePrNarrative(baseInput, logger);
    expect(result.why).toBe(baseInput.task);
  });

  it('handles reviewFocus being absent or empty array', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-test';
    setupDiffExec(SAMPLE_DIFF);
    anthropicCreateMock.mockResolvedValueOnce({
      content: [
        {
          type: 'text',
          text: JSON.stringify({ why: 'Why.', what: 'What.', how: null, reviewFocus: [] }),
        },
      ],
    });

    const result = await generatePrNarrative(baseInput, logger);
    expect(result.reviewFocus).toBeUndefined();
  });
});
