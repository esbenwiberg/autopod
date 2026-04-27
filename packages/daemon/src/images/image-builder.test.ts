import type { Profile } from '@autopod/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProfileStore } from '../profiles/index.js';
import type { AcrClient } from './acr-client.js';
import { ImageBuilder } from './image-builder.js';

function mockProfile(overrides: Partial<Profile> = {}): Profile {
  return {
    name: 'test-app',
    repoUrl: 'https://github.com/org/repo',
    defaultBranch: 'main',
    template: 'node22',
    buildCommand: 'npm run build',
    startCommand: 'npm start',
    healthPath: '/',
    healthTimeout: 120,
    smokePages: [],
    maxValidationAttempts: 3,
    defaultModel: 'opus',
    defaultRuntime: 'claude',
    executionTarget: 'local',
    customInstructions: null,
    escalation: {
      askHuman: true,
      askAi: { enabled: false, model: 'sonnet', maxCalls: 5 },
      advisor: { enabled: false },
      autoPauseAfter: 3,
      humanResponseTimeout: 3600,
    },
    extends: null,
    warmImageTag: null,
    warmImageBuiltAt: null,
    mcpServers: [],
    claudeMdSections: [],
    networkPolicy: null,
    actionPolicy: null,
    outputMode: 'pr' as const,
    modelProvider: 'anthropic' as const,
    providerCredentials: null,
    testCommand: null,
    prProvider: 'github' as const,
    adoPat: null,
    skills: [],
    privateRegistries: [],
    registryPat: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function createMockDeps() {
  const followProgressCb = vi.fn((_stream: unknown, onComplete: (err: Error | null) => void) => {
    onComplete(null);
  });

  const mockDocker = {
    buildImage: vi.fn().mockResolvedValue('mock-build-stream'),
    getImage: vi.fn().mockReturnValue({
      tag: vi.fn().mockResolvedValue(undefined),
      inspect: vi.fn().mockResolvedValue({ Size: 512 * 1_048_576 }),
    }),
    modem: { followProgress: followProgressCb },
  } as unknown as import('dockerode');

  const mockAcr = {
    push: vi.fn().mockResolvedValue('sha256:abc123'),
    pull: vi.fn().mockResolvedValue(undefined),
    exists: vi.fn().mockResolvedValue(true),
  } as unknown as AcrClient;

  const mockProfileStore = {
    update: vi.fn(),
    setWarmImage: vi.fn(),
    get: vi.fn(),
  } as unknown as ProfileStore;

  return { mockDocker, mockAcr, mockProfileStore, followProgressCb };
}

describe('ImageBuilder', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('builds and pushes warm image', async () => {
    const { mockDocker, mockAcr, mockProfileStore } = createMockDeps();
    const builder = new ImageBuilder({
      docker: mockDocker,
      acr: mockAcr,
      profileStore: mockProfileStore,
    });

    const profile = mockProfile();
    const result = await builder.buildWarmImage(profile);

    expect(result.tag).toBe('autopod/test-app:latest');
    expect(result.digest).toBe('sha256:abc123');
    expect(result.size).toBe(512 * 1_048_576);
    expect(result.buildDuration).toBeGreaterThanOrEqual(0);

    // Should push both latest and timestamped tags
    expect(mockAcr.push).toHaveBeenCalledTimes(2);
    expect(mockAcr.push).toHaveBeenCalledWith('autopod/test-app:latest');

    // Should update profile in DB
    expect(mockProfileStore.setWarmImage).toHaveBeenCalledWith(
      'test-app',
      'autopod/test-app:latest',
      expect.any(String),
    );
  });

  it('refuses to build if image is fresh and no --rebuild', async () => {
    const { mockDocker, mockAcr, mockProfileStore } = createMockDeps();
    const builder = new ImageBuilder({
      docker: mockDocker,
      acr: mockAcr,
      profileStore: mockProfileStore,
    });

    const freshProfile = mockProfile({
      warmImageTag: 'autopod/test-app:latest',
      warmImageBuiltAt: new Date().toISOString(),
    });

    await expect(builder.buildWarmImage(freshProfile)).rejects.toThrow('still fresh');
  });

  it('force builds with rebuild option', async () => {
    const { mockDocker, mockAcr, mockProfileStore } = createMockDeps();
    const builder = new ImageBuilder({
      docker: mockDocker,
      acr: mockAcr,
      profileStore: mockProfileStore,
    });

    const freshProfile = mockProfile({
      warmImageTag: 'autopod/test-app:latest',
      warmImageBuiltAt: new Date().toISOString(),
    });

    const result = await builder.buildWarmImage(freshProfile, { rebuild: true });
    expect(result.tag).toBeDefined();
    expect(mockAcr.push).toHaveBeenCalled();
  });

  it('builds when image is stale even without --rebuild', async () => {
    const { mockDocker, mockAcr, mockProfileStore } = createMockDeps();
    const builder = new ImageBuilder({
      docker: mockDocker,
      acr: mockAcr,
      profileStore: mockProfileStore,
    });

    const staleProfile = mockProfile({
      warmImageTag: 'autopod/test-app:latest',
      warmImageBuiltAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString(),
    });

    const result = await builder.buildWarmImage(staleProfile);
    expect(result.tag).toBeDefined();
  });

  describe('isStale', () => {
    it('returns true when no warmImageBuiltAt', () => {
      const { mockDocker, mockAcr, mockProfileStore } = createMockDeps();
      const builder = new ImageBuilder({
        docker: mockDocker,
        acr: mockAcr,
        profileStore: mockProfileStore,
      });

      expect(builder.isStale(mockProfile({ warmImageBuiltAt: null }))).toBe(true);
    });

    it('returns true when image is older than 7 days', () => {
      const { mockDocker, mockAcr, mockProfileStore } = createMockDeps();
      const builder = new ImageBuilder({
        docker: mockDocker,
        acr: mockAcr,
        profileStore: mockProfileStore,
      });

      const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
      expect(builder.isStale(mockProfile({ warmImageBuiltAt: old }))).toBe(true);
    });

    it('returns false when image is fresh', () => {
      const { mockDocker, mockAcr, mockProfileStore } = createMockDeps();
      const builder = new ImageBuilder({
        docker: mockDocker,
        acr: mockAcr,
        profileStore: mockProfileStore,
      });

      expect(builder.isStale(mockProfile({ warmImageBuiltAt: new Date().toISOString() }))).toBe(
        false,
      );
    });
  });

  it('passes gitPat as build arg when provided', async () => {
    const { mockDocker, mockAcr, mockProfileStore } = createMockDeps();
    const builder = new ImageBuilder({
      docker: mockDocker,
      acr: mockAcr,
      profileStore: mockProfileStore,
    });

    await builder.buildWarmImage(mockProfile(), { gitPat: 'ghp_secret123' });

    expect(mockDocker.buildImage).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        buildargs: { GIT_PAT: 'ghp_secret123' },
      }),
    );
  });

  it('does not pass build args when no gitPat or registryPat', async () => {
    const { mockDocker, mockAcr, mockProfileStore } = createMockDeps();
    const builder = new ImageBuilder({
      docker: mockDocker,
      acr: mockAcr,
      profileStore: mockProfileStore,
    });

    await builder.buildWarmImage(mockProfile());

    expect(mockDocker.buildImage).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        buildargs: undefined,
      }),
    );
  });

  it('passes REGISTRY_PAT and VSS_NUGET_EXTERNAL_FEED_ENDPOINTS when registryPat provided', async () => {
    const { mockDocker, mockAcr, mockProfileStore } = createMockDeps();
    const builder = new ImageBuilder({
      docker: mockDocker,
      acr: mockAcr,
      profileStore: mockProfileStore,
    });

    const profile = mockProfile({
      privateRegistries: [
        {
          type: 'npm',
          url: 'https://pkgs.dev.azure.com/org/_packaging/feed/npm/registry/',
          scope: '@org',
        },
        {
          type: 'nuget',
          url: 'https://pkgs.dev.azure.com/org/_packaging/feed/nuget/v3/index.json',
        },
      ],
    });

    await builder.buildWarmImage(profile, { registryPat: 'my-pat' });

    expect(mockDocker.buildImage).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        buildargs: expect.objectContaining({
          REGISTRY_PAT: 'my-pat',
          VSS_NUGET_EXTERNAL_FEED_ENDPOINTS: expect.stringContaining('endpointCredentials'),
        }),
      }),
    );

    // Verify the env var contains the correct feed endpoint
    const args = (mockDocker.buildImage as ReturnType<typeof vi.fn>).mock.calls[0][1].buildargs;
    const parsed = JSON.parse(args.VSS_NUGET_EXTERNAL_FEED_ENDPOINTS);
    expect(parsed.endpointCredentials).toHaveLength(1);
    expect(parsed.endpointCredentials[0].endpoint).toContain('nuget');
    expect(parsed.endpointCredentials[0].password).toBe('my-pat');
  });
});
