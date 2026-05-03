import type { ChildProcess } from 'node:child_process';
import type { Profile } from '@autopod/shared';
import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { generatePrNarrative, generatePrTitle } from './pr-description-generator.js';

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
  // Minimal Anthropic SDK shape: default-exported class with .messages.create().
  // The constructor records its args so tests can assert apiKey wiring if needed.
  const Anthropic = vi.fn().mockImplementation((opts: unknown) => {
    anthropicCtorMock(opts);
    return { messages: { create: anthropicCreateMock } };
  });
  return { default: Anthropic };
});

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

const SAMPLE_PROFILE = {
  name: 'test-profile',
  modelProvider: 'max',
  providerCredentials: { provider: 'max' },
  reviewerModel: null,
  defaultModel: null,
} as unknown as Profile;

const baseInput = {
  task: 'Add MSAL token refresh to prevent session expiry',
  worktreePath: '/tmp/wt',
  baseBranch: 'main',
  filesChanged: 3,
  linesAdded: 80,
  linesRemoved: 20,
  profile: SAMPLE_PROFILE,
  podModel: 'haiku',
};

describe('generatePrTitle', () => {
  beforeEach(() => {
    execFileMock.mockReset();
    anthropicCreateMock.mockReset();
    anthropicCtorMock.mockReset();
    process.env.ANTHROPIC_API_KEY = 'test-key';
  });

  afterEach(() => {
    Reflect.deleteProperty(process.env, 'ANTHROPIC_API_KEY');
  });

  it('returns LLM title on a successful call', async () => {
    setupDiffExec(SAMPLE_DIFF);
    anthropicCreateMock.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'feat(auth): add MSAL proactive token refresh' }],
    });

    const result = await generatePrTitle(baseInput, logger);
    expect(result.title).toBe('feat(auth): add MSAL proactive token refresh');
    expect(result.usedFallback).toBe(false);
    expect(result.fallbackReason).toBeUndefined();
    expect(anthropicCreateMock).toHaveBeenCalledOnce();
  });

  it('falls back when ANTHROPIC_API_KEY is unset (no_anthropic_api_key)', async () => {
    Reflect.deleteProperty(process.env, 'ANTHROPIC_API_KEY');
    setupDiffExec(SAMPLE_DIFF);

    const result = await generatePrTitle(baseInput, logger);
    expect(result.title).toContain('feat:');
    expect(result.usedFallback).toBe(true);
    expect(result.fallbackReason).toBe('no_anthropic_api_key');
    expect(anthropicCreateMock).not.toHaveBeenCalled();
  });

  it('falls back when LLM returns a title over 72 chars (output_invalid)', async () => {
    setupDiffExec(SAMPLE_DIFF);
    anthropicCreateMock.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'feat(auth): '.padEnd(80, 'x') }],
    });

    const result = await generatePrTitle(baseInput, logger);
    expect(result.title.length).toBeLessThanOrEqual(70);
    expect(result.usedFallback).toBe(true);
    expect(result.fallbackReason).toBe('output_invalid');
  });

  it('falls back when LLM title contains newlines', async () => {
    setupDiffExec(SAMPLE_DIFF);
    anthropicCreateMock.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'feat: add token refresh\n\nextra body' }],
    });

    const result = await generatePrTitle(baseInput, logger);
    expect(result.title).not.toContain('\n');
    expect(result.usedFallback).toBe(true);
    expect(result.fallbackReason).toBe('output_invalid');
  });

  it('falls back on API error (api_call_failed)', async () => {
    setupDiffExec(SAMPLE_DIFF);
    anthropicCreateMock.mockRejectedValueOnce(new Error('503 service unavailable'));

    const result = await generatePrTitle(baseInput, logger);
    expect(result.title).toContain('feat:');
    expect(result.usedFallback).toBe(true);
    expect(result.fallbackReason).toBe('api_call_failed');
    expect(result.fallbackDetail).toContain('503');
  });

  it('uses handoffInstructions over task in fallback for promoted pods', async () => {
    Reflect.deleteProperty(process.env, 'ANTHROPIC_API_KEY');
    setupDiffExec(SAMPLE_DIFF);

    const result = await generatePrTitle(
      {
        ...baseInput,
        task: '#4',
        handoffInstructions: 'fix login redirect to honour ?next= param',
      },
      logger,
    );
    expect(result.title).toContain('login redirect');
    expect(result.usedFallback).toBe(true);
  });

  it('passes handoffInstructions to the LLM message body', async () => {
    setupDiffExec(SAMPLE_DIFF);
    anthropicCreateMock.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'feat: route ?next= through redirect' }],
    });

    await generatePrTitle(
      { ...baseInput, task: '#4', handoffInstructions: 'fix login redirect' },
      logger,
    );

    const callArgs = anthropicCreateMock.mock.calls[0]?.[0] as {
      messages: Array<{ content: string }>;
    };
    expect(callArgs.messages[0]?.content).toContain('fix login redirect');
  });

  it('instantiates the Anthropic SDK with the host env var', async () => {
    setupDiffExec(SAMPLE_DIFF);
    anthropicCreateMock.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'feat: ok' }],
    });

    await generatePrTitle(baseInput, logger);
    expect(anthropicCtorMock).toHaveBeenCalledWith({ apiKey: 'test-key' });
  });
});

describe('generatePrNarrative', () => {
  const validNarrativeJson = JSON.stringify({
    why: 'Sessions were silently expiring after 30 minutes.',
    what: 'Added proactive token refresh with a 5-minute expiry window in token-manager.ts.',
    how: 'Used MSAL acquireTokenSilent with a custom expiry check.',
    reviewFocus: ['packages/cli/src/auth/token-manager.ts'],
  });

  beforeEach(() => {
    execFileMock.mockReset();
    anthropicCreateMock.mockReset();
    anthropicCtorMock.mockReset();
    process.env.ANTHROPIC_API_KEY = 'test-key';
  });

  afterEach(() => {
    Reflect.deleteProperty(process.env, 'ANTHROPIC_API_KEY');
  });

  it('returns parsed narrative on a successful LLM call', async () => {
    setupDiffExec(SAMPLE_DIFF);
    anthropicCreateMock.mockResolvedValueOnce({
      content: [{ type: 'text', text: validNarrativeJson }],
    });

    const result = await generatePrNarrative(baseInput, logger);
    expect(result.usedFallback).toBe(false);
    expect(result.fallbackReason).toBeUndefined();
    expect(result.narrative.why).toBe('Sessions were silently expiring after 30 minutes.');
    expect(result.narrative.what).toContain('proactive token refresh');
    expect(result.narrative.how).toContain('acquireTokenSilent');
    expect(result.narrative.reviewFocus).toEqual(['packages/cli/src/auth/token-manager.ts']);
  });

  it('falls back to plain taskSummary when ANTHROPIC_API_KEY is unset (no_anthropic_api_key)', async () => {
    Reflect.deleteProperty(process.env, 'ANTHROPIC_API_KEY');
    setupDiffExec(SAMPLE_DIFF);

    const result = await generatePrNarrative(
      { ...baseInput, taskSummary: { actualSummary: 'Did the thing.', deviations: [] } },
      logger,
    );
    expect(result.usedFallback).toBe(true);
    expect(result.fallbackReason).toBe('no_anthropic_api_key');
    expect(result.narrative.why).toBe(baseInput.task);
    expect(result.narrative.what).toBe('Did the thing.');
    expect(anthropicCreateMock).not.toHaveBeenCalled();
  });

  it('falls back on invalid JSON response (json_parse_failed)', async () => {
    setupDiffExec(SAMPLE_DIFF);
    anthropicCreateMock.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'Here is your narrative: sorry not json' }],
    });

    const result = await generatePrNarrative(baseInput, logger);
    expect(result.usedFallback).toBe(true);
    expect(result.fallbackReason).toBe('json_parse_failed');
    expect(result.narrative.why).toBe(baseInput.task);
    expect(result.narrative.reviewFocus).toBeUndefined();
  });

  it('strips markdown code fences from LLM output before parsing', async () => {
    setupDiffExec(SAMPLE_DIFF);
    anthropicCreateMock.mockResolvedValueOnce({
      content: [{ type: 'text', text: `\`\`\`json\n${validNarrativeJson}\n\`\`\`` }],
    });

    const result = await generatePrNarrative(baseInput, logger);
    expect(result.usedFallback).toBe(false);
    expect(result.narrative.why).toBe('Sessions were silently expiring after 30 minutes.');
  });

  it('falls back on API error (api_call_failed)', async () => {
    setupDiffExec(SAMPLE_DIFF);
    anthropicCreateMock.mockRejectedValueOnce(new Error('timeout'));

    const result = await generatePrNarrative(baseInput, logger);
    expect(result.usedFallback).toBe(true);
    expect(result.fallbackReason).toBe('api_call_failed');
    expect(result.fallbackDetail).toContain('timeout');
    expect(result.narrative.why).toBe(baseInput.task);
  });

  it('handles reviewFocus being absent or empty array', async () => {
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
    expect(result.usedFallback).toBe(false);
    expect(result.narrative.reviewFocus).toBeUndefined();
  });

  it('uses handoffInstructions in fallback when env var unset and no taskSummary', async () => {
    Reflect.deleteProperty(process.env, 'ANTHROPIC_API_KEY');
    setupDiffExec(SAMPLE_DIFF);

    const result = await generatePrNarrative(
      {
        ...baseInput,
        task: '#4',
        handoffInstructions: 'wire the redirect param through to the login callback',
      },
      logger,
    );
    expect(result.usedFallback).toBe(true);
    expect(result.narrative.why).toContain('redirect param');
    expect(result.narrative.what).toContain('redirect param');
  });
});
