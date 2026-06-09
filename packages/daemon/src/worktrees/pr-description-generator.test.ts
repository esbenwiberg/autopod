import type { ChildProcess } from 'node:child_process';
import type { Profile } from '@autopod/shared';
import pino from 'pino';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { generatePrNarrative, generatePrTitle } from './pr-description-generator.js';

const logger = pino({ level: 'silent' });

const { execFileMock, anthropicCreateMock, createClientMock } = vi.hoisted(() => ({
  execFileMock: vi.fn(),
  anthropicCreateMock: vi.fn(),
  createClientMock: vi.fn(),
}));

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  return { ...actual, execFile: execFileMock };
});

vi.mock('../providers/llm-client.js', () => ({
  createProfileAnthropicClient: createClientMock,
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

function mockClientOk(model = 'claude-haiku-4-5') {
  createClientMock.mockResolvedValue({
    ok: true,
    client: { messages: { create: anthropicCreateMock } },
    model,
  });
}

function expectAnthropicCreateTimeoutOption(timeoutMs: number): void {
  const call = anthropicCreateMock.mock.calls[0];
  expect(call).toBeDefined();
  if (!call) throw new Error('messages.create was not called');

  const body = call[0] as Record<string, unknown>;
  const options = call[1] as Record<string, unknown> | undefined;
  expect(body).not.toHaveProperty('timeout');
  expect(options).toEqual({ timeout: timeoutMs });
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
    createClientMock.mockReset();
    mockClientOk();
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
    expectAnthropicCreateTimeoutOption(15_000);
  });

  it('falls back when profile cannot back a daemon-side LLM call (no_anthropic_api_key)', async () => {
    createClientMock.mockResolvedValueOnce({ ok: false, reason: 'no_anthropic_api_key' });
    setupDiffExec(SAMPLE_DIFF);

    const result = await generatePrTitle(baseInput, logger);
    expect(result.title).toContain('feat:');
    expect(result.usedFallback).toBe(true);
    expect(result.fallbackReason).toBe('no_anthropic_api_key');
    expect(anthropicCreateMock).not.toHaveBeenCalled();
  });

  it('propagates no_credentials when the profile has no provider creds', async () => {
    createClientMock.mockResolvedValueOnce({ ok: false, reason: 'no_credentials' });
    setupDiffExec(SAMPLE_DIFF);

    const result = await generatePrTitle(baseInput, logger);
    expect(result.usedFallback).toBe(true);
    expect(result.fallbackReason).toBe('no_credentials');
    expect(anthropicCreateMock).not.toHaveBeenCalled();
  });

  it('propagates provider_not_callable for copilot profiles', async () => {
    createClientMock.mockResolvedValueOnce({ ok: false, reason: 'provider_not_callable' });
    setupDiffExec(SAMPLE_DIFF);

    const result = await generatePrTitle(baseInput, logger);
    expect(result.usedFallback).toBe(true);
    expect(result.fallbackReason).toBe('provider_not_callable');
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
    createClientMock.mockResolvedValueOnce({ ok: false, reason: 'no_anthropic_api_key' });
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

  it('routes through createProfileAnthropicClient with the picked description model', async () => {
    setupDiffExec(SAMPLE_DIFF);
    anthropicCreateMock.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'feat: ok' }],
    });

    await generatePrTitle(
      {
        ...baseInput,
        profile: { ...SAMPLE_PROFILE, reviewerModel: 'sonnet' } as unknown as Profile,
      },
      logger,
    );
    expect(createClientMock).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'test-profile' }),
      'sonnet',
      logger,
    );
  });

  it('uses the model returned by the client (alias-resolved) when calling messages.create', async () => {
    setupDiffExec(SAMPLE_DIFF);
    mockClientOk('claude-sonnet-4-6');
    anthropicCreateMock.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'feat: ok' }],
    });

    await generatePrTitle(baseInput, logger);
    const callArgs = anthropicCreateMock.mock.calls[0]?.[0] as { model: string };
    expect(callArgs.model).toBe('claude-sonnet-4-6');
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
    createClientMock.mockReset();
    mockClientOk();
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
    expectAnthropicCreateTimeoutOption(15_000);
  });

  it('falls back to plain taskSummary when the profile cannot back a daemon-side LLM call (no_anthropic_api_key)', async () => {
    createClientMock.mockResolvedValueOnce({ ok: false, reason: 'no_anthropic_api_key' });
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

  it('propagates foundry_openai_surface when foundry profile uses openai endpoint', async () => {
    createClientMock.mockResolvedValueOnce({ ok: false, reason: 'foundry_openai_surface' });
    setupDiffExec(SAMPLE_DIFF);

    const result = await generatePrNarrative(baseInput, logger);
    expect(result.usedFallback).toBe(true);
    expect(result.fallbackReason).toBe('foundry_openai_surface');
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

  it('uses handoffInstructions in fallback when LLM unavailable and no taskSummary', async () => {
    createClientMock.mockResolvedValueOnce({ ok: false, reason: 'no_anthropic_api_key' });
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
