import type { Profile } from '@autopod/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
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
    validationPages: [],
    maxValidationAttempts: 3,
    defaultModel: 'opus',
    defaultRuntime: 'claude',
    executionTarget: 'local',
    customInstructions: null,
    escalation: {
      askHuman: true,
      askAi: { enabled: false, model: 'sonnet', maxCalls: 5 },
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
  } as any;

  const mockAcr = {
    push: vi.fn().mockResolvedValue('sha256:abc123'),
    pull: vi.fn().mockResolvedValue(undefined),
    exists: vi.fn().mockResolvedValue(true),
  } as any;

  const mockProfileStore = {
    update: vi.fn(),
    get: vi.fn(),
  } as any;

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
    expect(mockProfileStore.update).toHaveBeenCalledWith('test-app', {
      warmImageTag: 'autopod/test-app:latest',
      warmImageBuiltAt: expect.any(String),
    });
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

  it('does not pass build args when no gitPat', async () => {
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
});
