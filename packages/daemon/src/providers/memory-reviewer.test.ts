import type { Profile } from '@autopod/shared';
import pino from 'pino';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createProfileMemoryReviewer } from './memory-reviewer.js';

const logger = pino({ level: 'silent' });

function makeProfile(overrides: Partial<Profile> = {}): Profile {
  return {
    name: 'openai-profile',
    repoUrl: 'https://github.com/org/repo',
    defaultBranch: 'main',
    template: 'node22',
    buildCommand: 'npm run build',
    startCommand: 'npm start',
    healthPath: '/health',
    healthTimeout: 120,
    smokePages: [],
    maxValidationAttempts: 3,
    defaultModel: 'gpt-5.5',
    reviewerModel: 'gpt-5.5',
    defaultRuntime: 'codex',
    executionTarget: null,
    hasWebUi: false,
    podOptions: null,
    networkPolicy: null,
    actions: null,
    mcpServers: [],
    claudeMdSections: [],
    skills: [],
    githubPat: null,
    adoPat: null,
    prProvider: 'github',
    autoMerge: false,
    referenceRepo: null,
    privateRegistries: [],
    containerMemoryGb: null,
    containerCpus: null,
    maxPrFixAttempts: 3,
    extends: null,
    modelProvider: 'openai',
    providerCredentials: null,
    warmImageTag: null,
    warmImageBuiltAt: null,
    pimConfig: null,
    issueWatcherConfig: null,
    escalationConfig: null,
    ...overrides,
  } as unknown as Profile;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('createProfileMemoryReviewer', () => {
  it('creates an OpenAI reviewer from daemon OPENAI_API_KEY', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'sk-test');
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: '{"create":false}' } }],
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await createProfileMemoryReviewer(makeProfile(), 'gpt-5.5', logger);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const text = await result.reviewer.generateText({
      systemPrompt: 'system',
      userMessage: 'user',
      maxTokens: 64,
    });

    expect(text).toBe('{"create":false}');
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.openai.com/v1/chat/completions',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ authorization: 'Bearer sk-test' }),
      }),
    );
  });

  it('uses the ChatGPT auth access token from OpenAI authJson when no API key is set', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: '{"create":true}' } }],
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await createProfileMemoryReviewer(
      makeProfile({
        providerCredentials: {
          provider: 'openai',
          authMode: 'chatgpt',
          authJson: JSON.stringify({ tokens: { access_token: 'chatgpt-access' } }),
        },
      }),
      'gpt-5.5',
      logger,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    await result.reviewer.generateText({
      systemPrompt: 'system',
      userMessage: 'user',
      maxTokens: 64,
    });

    expect(fetchMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: expect.objectContaining({ authorization: 'Bearer chatgpt-access' }),
      }),
    );
  });

  it('maps Codex auto reviewer model to a callable OpenAI reviewer model', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'sk-test');
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: '{"create":false}' } }],
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await createProfileMemoryReviewer(makeProfile(), 'auto', logger);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.model).toBe('gpt-5-mini');
    await result.reviewer.generateText({
      systemPrompt: 'system',
      userMessage: 'user',
      maxTokens: 64,
    });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as { model: string };
    expect(body.model).toBe('gpt-5-mini');
  });

  it('returns an explicit unavailable reason when OpenAI auth is missing', async () => {
    const result = await createProfileMemoryReviewer(makeProfile(), 'gpt-5.5', logger);

    expect(result).toEqual({ ok: false, reason: 'openai_auth_unavailable' });
  });
});
