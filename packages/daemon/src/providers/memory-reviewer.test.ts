import type { Profile } from '@autopod/shared';
import pino from 'pino';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runContainerReviewer } from '../validation/container-reviewer-runner.js';
import { createProfileMemoryReviewer } from './memory-reviewer.js';

vi.mock('../validation/container-reviewer-runner.js', async () => {
  const actual = await vi.importActual<typeof import('../validation/container-reviewer-runner.js')>(
    '../validation/container-reviewer-runner.js',
  );
  return {
    ...actual,
    runContainerReviewer: vi.fn(),
  };
});

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
  vi.mocked(runContainerReviewer).mockReset();
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

  it('does not treat a ChatGPT OAuth token as a daemon OpenAI API key', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'sk-daemon-must-not-be-used');
    const fetchMock = vi.fn();
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

    expect(result).toEqual({
      ok: false,
      reason: 'container_reviewer_unavailable: ChatGPT-auth review requires a live pod container',
    });
    expect(fetchMock).not.toHaveBeenCalled();
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

  it('prefers the live container reviewer for ChatGPT/OpenAI profiles', async () => {
    vi.mocked(runContainerReviewer).mockResolvedValue({ stdout: '{"selected":[]}' });

    const result = await createProfileMemoryReviewer(makeProfile(), 'gpt-5.5', logger, {
      container: {
        podId: 'pod-1',
        containerId: 'container-1',
        containerManager: {} as never,
        env: { OPENAI_API_KEY_FILE: '/run/autopod/openai-api-key' },
        timeoutMs: 20_000,
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    await expect(
      result.reviewer.generateText({
        systemPrompt: 'system',
        userMessage: 'user',
        maxTokens: 64,
      }),
    ).resolves.toBe('{"selected":[]}');
    expect(runContainerReviewer).toHaveBeenCalledWith(
      expect.objectContaining({
        podId: 'pod-1',
        containerId: 'container-1',
        model: 'gpt-5.5',
        prompt: 'system\n\nuser',
        env: { OPENAI_API_KEY_FILE: '/run/autopod/openai-api-key' },
        timeout: 20_000,
      }),
    );
  });

  it('maps auto to gpt-5-mini for the container reviewer on API-key OpenAI auth', async () => {
    vi.mocked(runContainerReviewer).mockResolvedValue({ stdout: '{"selected":[]}' });

    const result = await createProfileMemoryReviewer(makeProfile(), 'auto', logger, {
      container: {
        podId: 'pod-1',
        containerId: 'container-1',
        containerManager: {} as never,
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.model).toBe('gpt-5-mini');
    await result.reviewer.generateText({
      systemPrompt: 'system',
      userMessage: 'user',
      maxTokens: 64,
    });
    expect(runContainerReviewer).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'gpt-5-mini' }),
    );
  });

  it('keeps auto (no gpt-5-mini) for the container reviewer on ChatGPT-auth Codex', async () => {
    vi.mocked(runContainerReviewer).mockResolvedValue({ stdout: '{"selected":[]}' });

    const result = await createProfileMemoryReviewer(
      makeProfile({
        providerCredentials: {
          provider: 'openai',
          authMode: 'chatgpt',
          authJson: JSON.stringify({ tokens: { access_token: 'chatgpt-access' } }),
        } as never,
      }),
      'auto',
      logger,
      {
        container: {
          podId: 'pod-1',
          containerId: 'container-1',
          containerManager: {} as never,
        },
      },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // gpt-5-mini is rejected by Codex on a ChatGPT account, so we must not force it.
    expect(result.model).toBe('auto');
    await result.reviewer.generateText({
      systemPrompt: 'system',
      userMessage: 'user',
      maxTokens: 64,
    });
    expect(runContainerReviewer).toHaveBeenCalledWith(expect.objectContaining({ model: 'auto' }));
  });

  it('falls back to the daemon reviewer when the live container reviewer fails', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'sk-test');
    vi.mocked(runContainerReviewer).mockRejectedValue(new Error('container timed out'));
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: '{"selected":[{"id":"mem"}]}' } }],
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await createProfileMemoryReviewer(makeProfile(), 'gpt-5.5', logger, {
      container: {
        podId: 'pod-1',
        containerId: 'container-1',
        containerManager: {} as never,
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    await expect(
      result.reviewer.generateText({
        systemPrompt: 'system',
        userMessage: 'user',
        maxTokens: 64,
      }),
    ).resolves.toBe('{"selected":[{"id":"mem"}]}');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('throws a combined unavailable reason when container and daemon fallback both fail', async () => {
    vi.mocked(runContainerReviewer).mockRejectedValue(new Error('container timed out'));

    const result = await createProfileMemoryReviewer(makeProfile(), 'gpt-5.5', logger, {
      container: {
        podId: 'pod-1',
        containerId: 'container-1',
        containerManager: {} as never,
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    await expect(
      result.reviewer.generateText({
        systemPrompt: 'system',
        userMessage: 'user',
        maxTokens: 64,
      }),
    ).rejects.toThrow(
      'container_reviewer_unavailable: container timed out; daemon_reviewer_unavailable: openai_auth_unavailable',
    );
  });

  it('does not escape to daemon HTTP when a ChatGPT-auth container review fails', async () => {
    vi.mocked(runContainerReviewer).mockRejectedValue(new Error('container status was unknown'));
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      text: async () => 'You exceeded your current quota',
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await createProfileMemoryReviewer(
      makeProfile({
        providerCredentials: {
          provider: 'openai',
          authMode: 'chatgpt',
          authJson: JSON.stringify({ tokens: { access_token: 'chatgpt-access' } }),
        } as never,
      }),
      'auto',
      logger,
      {
        container: {
          podId: 'pod-1',
          containerId: 'container-1',
          containerManager: {} as never,
        },
      },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    await expect(
      result.reviewer.generateText({
        systemPrompt: 'system',
        userMessage: 'user',
        maxTokens: 64,
      }),
    ).rejects.toThrow('container_reviewer_unavailable: container status was unknown');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not construct daemon fallback before a successful live container review', async () => {
    vi.mocked(runContainerReviewer).mockResolvedValue({ stdout: '{"selected":[]}' });

    const result = await createProfileMemoryReviewer(makeProfile(), 'gpt-5.5', logger, {
      container: {
        podId: 'pod-1',
        containerId: 'container-1',
        containerManager: {} as never,
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    await result.reviewer.generateText({
      systemPrompt: 'system',
      userMessage: 'user',
      maxTokens: 64,
    });
    expect(runContainerReviewer).toHaveBeenCalledTimes(1);
  });

  it('marks Copilot unavailable for automatic memory review when no daemon fallback exists', async () => {
    const result = await createProfileMemoryReviewer(
      makeProfile({ modelProvider: 'copilot' }),
      'gpt-5.5',
      logger,
      {
        container: {
          podId: 'pod-1',
          containerId: 'container-1',
          containerManager: {} as never,
        },
      },
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('provider copilot is not supported');
    expect(result.reason).toContain('daemon_reviewer_unavailable: provider_not_callable');
  });
});
