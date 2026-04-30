import type { ChildProcess } from 'node:child_process';
import type { Profile } from '@autopod/shared';
import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

/** Wire createProfileAnthropicClient to return a stub client wrapping anthropicCreateMock. */
function setupClientAvailable() {
  createClientMock.mockResolvedValue({
    client: { messages: { create: anthropicCreateMock } },
    model: 'claude-haiku-4-5',
  });
}

/** Wire createProfileAnthropicClient to return null (provider not daemon-callable). */
function setupClientUnavailable() {
  createClientMock.mockResolvedValue(null);
}

const SAMPLE_DIFF = `diff --git a/src/auth/token-manager.ts b/src/auth/token-manager.ts
+  async refreshToken() { ... }
-  async getToken() { ... }
`;

const SAMPLE_PROFILE = {
  name: 'test-profile',
  modelProvider: 'max',
  providerCredentials: { provider: 'max' },
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
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns LLM title on a successful call', async () => {
    setupClientAvailable();
    setupDiffExec(SAMPLE_DIFF);
    anthropicCreateMock.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'feat(auth): add MSAL proactive token refresh' }],
    });

    const title = await generatePrTitle(baseInput, logger);
    expect(title).toBe('feat(auth): add MSAL proactive token refresh');
    expect(anthropicCreateMock).toHaveBeenCalledOnce();
  });

  it('falls back to buildPrTitle when client is unavailable', async () => {
    setupClientUnavailable();
    setupDiffExec(SAMPLE_DIFF);

    const title = await generatePrTitle(baseInput, logger);
    expect(title).toContain('feat:');
    expect(anthropicCreateMock).not.toHaveBeenCalled();
  });

  it('falls back when LLM returns a title over 72 chars', async () => {
    setupClientAvailable();
    setupDiffExec(SAMPLE_DIFF);
    anthropicCreateMock.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'feat(auth): '.padEnd(80, 'x') }],
    });

    const title = await generatePrTitle(baseInput, logger);
    // Falls back to buildPrTitle which truncates to ≤70 chars
    expect(title.length).toBeLessThanOrEqual(70);
  });

  it('falls back when LLM title contains newlines', async () => {
    setupClientAvailable();
    setupDiffExec(SAMPLE_DIFF);
    anthropicCreateMock.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'feat: add token refresh\n\nextra body' }],
    });

    const title = await generatePrTitle(baseInput, logger);
    expect(title).not.toContain('\n');
  });

  it('falls back on API error', async () => {
    setupClientAvailable();
    setupDiffExec(SAMPLE_DIFF);
    anthropicCreateMock.mockRejectedValueOnce(new Error('503 service unavailable'));

    const title = await generatePrTitle(baseInput, logger);
    expect(title).toContain('feat:');
  });

  it('uses handoffInstructions over task in fallback for promoted pods', async () => {
    setupClientUnavailable();
    setupDiffExec(SAMPLE_DIFF);

    const title = await generatePrTitle(
      {
        ...baseInput,
        task: '#4',
        handoffInstructions: 'fix login redirect to honour ?next= param',
      },
      logger,
    );
    expect(title).toContain('login redirect');
  });

  it('passes handoffInstructions to the LLM message body', async () => {
    setupClientAvailable();
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
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns parsed narrative on a successful LLM call', async () => {
    setupClientAvailable();
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

  it('falls back to plain taskSummary when client is unavailable', async () => {
    setupClientUnavailable();
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
    setupClientAvailable();
    setupDiffExec(SAMPLE_DIFF);
    anthropicCreateMock.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'Here is your narrative: sorry not json' }],
    });

    const result = await generatePrNarrative(baseInput, logger);
    expect(result.why).toBe(baseInput.task);
    expect(result.reviewFocus).toBeUndefined();
  });

  it('strips markdown code fences from LLM output before parsing', async () => {
    setupClientAvailable();
    setupDiffExec(SAMPLE_DIFF);
    anthropicCreateMock.mockResolvedValueOnce({
      content: [{ type: 'text', text: `\`\`\`json\n${validNarrativeJson}\n\`\`\`` }],
    });

    const result = await generatePrNarrative(baseInput, logger);
    expect(result.why).toBe('Sessions were silently expiring after 30 minutes.');
  });

  it('falls back on API error', async () => {
    setupClientAvailable();
    setupDiffExec(SAMPLE_DIFF);
    anthropicCreateMock.mockRejectedValueOnce(new Error('timeout'));

    const result = await generatePrNarrative(baseInput, logger);
    expect(result.why).toBe(baseInput.task);
  });

  it('handles reviewFocus being absent or empty array', async () => {
    setupClientAvailable();
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

  it('uses handoffInstructions in fallback when client unavailable and no taskSummary', async () => {
    setupClientUnavailable();
    setupDiffExec(SAMPLE_DIFF);

    const result = await generatePrNarrative(
      {
        ...baseInput,
        task: '#4',
        handoffInstructions: 'wire the redirect param through to the login callback',
      },
      logger,
    );
    expect(result.why).toContain('redirect param');
    expect(result.what).toContain('redirect param');
  });
});
