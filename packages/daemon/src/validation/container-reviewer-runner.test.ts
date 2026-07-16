import type { Profile } from '@autopod/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ContainerManager } from '../interfaces/container-manager.js';
import {
  ContainerReviewerUnavailableError,
  resolveContainerReviewer,
  runContainerReviewer,
} from './container-reviewer-runner.js';
import { runCodexReview } from './review-codex-runner.js';

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
  return {
    writeFile: vi.fn().mockResolvedValue(undefined),
    execInContainer: vi.fn().mockResolvedValue(execResult),
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
    const cm = containerManager();

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
    expect(cm.writeFile).toHaveBeenCalledWith(
      'container-abc',
      expect.stringContaining('/tmp/autopod-claude-review-sess-1-'),
      'Generate script',
    );
    expect(cm.execInContainer).toHaveBeenCalledWith(
      'container-abc',
      ['sh', '-c', expect.stringContaining("sh '/run/autopod/agent-shim.sh' claude -p")],
      expect.objectContaining({
        cwd: '/workspace',
        env: { ANTHROPIC_API_KEY_FILE: '/run/autopod/anthropic-api-key' },
        timeout: 60_000,
      }),
    );
    expect(mockRunCodexReview).not.toHaveBeenCalled();
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
});
