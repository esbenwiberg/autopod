import { type Profile, environmentPresetSchema } from '@autopod/shared';
import { extract as tarExtract } from 'tar-stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProfileStore } from '../profiles/index.js';
import type { AcrClient } from './acr-client.js';
import { environmentImageKey } from './environment-image-key.js';
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
    skills: [],
    privateRegistries: [],
    registryPat: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

async function readDockerfile(stream: NodeJS.ReadableStream): Promise<string> {
  return new Promise((resolve, reject) => {
    const extract = tarExtract();
    let dockerfile = '';
    extract.on('entry', (header, entry, next) => {
      const chunks: Buffer[] = [];
      entry.on('data', (chunk: Buffer) => chunks.push(chunk));
      entry.on('end', () => {
        if (header.name === 'Dockerfile') dockerfile = Buffer.concat(chunks).toString('utf8');
        next();
      });
      entry.on('error', reject);
    });
    extract.on('finish', () => resolve(dockerfile));
    extract.on('error', reject);
    stream.pipe(extract);
  });
}

function createMockDeps() {
  const followProgressCb = vi.fn((_stream: unknown, onComplete: (err: Error | null) => void) => {
    onComplete(null);
  });
  const dockerfiles: string[] = [];

  const mockDocker = {
    buildImage: vi.fn(async (stream: NodeJS.ReadableStream) => {
      dockerfiles.push(await readDockerfile(stream));
      return 'mock-build-stream';
    }),
    getImage: vi.fn().mockReturnValue({
      tag: vi.fn().mockResolvedValue(undefined),
      inspect: vi.fn().mockResolvedValue({ Size: 512 * 1_048_576 }),
    }),
    modem: { followProgress: followProgressCb },
  } as unknown as import('dockerode');

  const mockAcr = {
    push: vi.fn().mockResolvedValue('sha256:abc123'),
    pull: vi.fn().mockResolvedValue(undefined),
    pullPinned: vi.fn(
      async (tag: string) => `ewiacr.azurecr.io/${tag.replace(/:latest$/, '@sha256:base-digest')}`,
    ),
    exists: vi.fn().mockResolvedValue(true),
    resolveTag: vi.fn((tag: string) => `ewiacr.azurecr.io/${tag}`),
  } as unknown as AcrClient;

  const mockProfileStore = {
    update: vi.fn(),
    setWarmImage: vi.fn(),
    get: vi.fn(),
  } as unknown as ProfileStore;

  return { mockDocker, mockAcr, mockProfileStore, followProgressCb, dockerfiles };
}

describe('ImageBuilder', () => {
  it('resolves software-only preview inputs without pulling, building or publishing', async () => {
    const deps = createMockDeps();
    const inspect = vi.mocked(deps.mockDocker.getImage('base').inspect);
    inspect.mockResolvedValue({
      Id: `sha256:${'a'.repeat(64)}`,
      Os: 'linux',
      Architecture: 'arm64',
    } as unknown as import('dockerode').ImageInspectInfo);
    const builder = new ImageBuilder({
      docker: deps.mockDocker,
      acr: null,
      profileStore: deps.mockProfileStore,
    });
    const environment = environmentPresetSchema.parse({
      template: 'node22',
      tools: [{ name: 'pnpm', version: '9.15.0' }],
    });
    const first = await builder.resolveEnvironment(environment, 'local');
    expect(first.platform).toBe('linux/arm64');
    inspect.mockResolvedValue({
      Id: `sha256:${'b'.repeat(64)}`,
      Os: 'linux',
      Architecture: 'arm64',
    } as unknown as import('dockerode').ImageInspectInfo);
    const next = await builder.resolveEnvironment(environment, 'local');
    expect(next.imageKey).not.toBe(first.imageKey);
    expect(first.pinnedBase).toBe(`sha256:${'a'.repeat(64)}`);
    expect(deps.mockDocker.buildImage).not.toHaveBeenCalled();
    expect(deps.mockAcr.pull).not.toHaveBeenCalled();
    expect(deps.mockAcr.push).not.toHaveBeenCalled();
    expect(deps.mockProfileStore.setWarmImage).not.toHaveBeenCalled();
  });
  it('pulls the pinned registry base when the local environment base is missing', async () => {
    const deps = createMockDeps();
    const inspect = vi.mocked(deps.mockDocker.getImage('base').inspect);
    inspect.mockRejectedValueOnce({ statusCode: 404 }).mockResolvedValue({
      Id: `sha256:${'d'.repeat(64)}`,
      Os: 'linux',
      Architecture: 'amd64',
    } as unknown as import('dockerode').ImageInspectInfo);
    const builder = new ImageBuilder({
      docker: deps.mockDocker,
      acr: deps.mockAcr,
      profileStore: deps.mockProfileStore,
    });
    const resolved = await builder.resolveEnvironment(
      environmentPresetSchema.parse({ template: 'dotnet10-go' }),
      'local',
    );
    expect(deps.mockAcr.pullPinned).toHaveBeenCalledWith('autopod-dotnet10-go:latest');
    expect(deps.mockDocker.getImage).toHaveBeenLastCalledWith(
      'ewiacr.azurecr.io/autopod-dotnet10-go@sha256:base-digest',
    );
    expect(resolved.pinnedBase).toBe(`sha256:${'d'.repeat(64)}`);
    expect(resolved.platform).toBe('linux/amd64');
    expect(deps.mockDocker.buildImage).not.toHaveBeenCalled();
    expect(deps.mockAcr.push).not.toHaveBeenCalled();
  });

  it.each([
    ['no registry is configured', false],
    ['the registry pull fails', true],
  ])('reports an unavailable environment base when %s', async (_case, withAcr) => {
    const deps = createMockDeps();
    vi.mocked(deps.mockDocker.getImage('base').inspect).mockRejectedValue({ statusCode: 404 });
    vi.mocked(deps.mockAcr.pullPinned).mockRejectedValue(new Error('unauthorized'));
    const builder = new ImageBuilder({
      docker: deps.mockDocker,
      acr: withAcr ? deps.mockAcr : null,
      profileStore: deps.mockProfileStore,
    });
    await expect(
      builder.resolveEnvironment(environmentPresetSchema.parse({ template: 'node22' }), 'local'),
    ).rejects.toMatchObject({ code: 'ENVIRONMENT_BASE_UNAVAILABLE', statusCode: 424 });
  });

  it('does not mask non-missing local inspect failures', async () => {
    const deps = createMockDeps();
    vi.mocked(deps.mockDocker.getImage('base').inspect).mockRejectedValue(
      Object.assign(new Error('daemon down'), { statusCode: 500 }),
    );
    const builder = new ImageBuilder({
      docker: deps.mockDocker,
      acr: deps.mockAcr,
      profileStore: deps.mockProfileStore,
    });
    await expect(
      builder.resolveEnvironment(environmentPresetSchema.parse({ template: 'node22' }), 'local'),
    ).rejects.toThrow('daemon down');
    expect(deps.mockAcr.pullPinned).not.toHaveBeenCalled();
  });
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('builds software once with no repository credentials and returns immutable identity', async () => {
    const { mockDocker, mockProfileStore, dockerfiles } = createMockDeps();
    const input = {
      environment: environmentPresetSchema.parse({ template: 'node22' }),
      pinnedBase: `base@sha256:${'a'.repeat(64)}`,
      platform: 'linux/amd64' as const,
      agentToolingDigest: 'b'.repeat(64),
      toolInstallCommands: ['echo ready'],
    };
    const digest = `sha256:${'c'.repeat(64)}`;
    vi.mocked(mockDocker.getImage('image').inspect)
      .mockRejectedValueOnce({ statusCode: 404 })
      .mockResolvedValue({
        Id: digest,
        Size: 1,
        Config: { Labels: { 'com.autopod.environment-key': environmentImageKey(input) } },
      } as unknown as Awaited<ReturnType<import('dockerode').Image['inspect']>>);
    const builder = new ImageBuilder({
      docker: mockDocker,
      acr: null,
      profileStore: mockProfileStore,
    });
    expect((await builder.buildEnvironmentImage(input)).tag).toBe(digest);
    expect((await builder.buildEnvironmentImage(input)).tag).toBe(digest);
    expect(mockDocker.buildImage).toHaveBeenCalledTimes(1);
    expect(mockDocker.buildImage).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ buildargs: undefined, platform: 'linux/amd64' }),
    );
    expect(dockerfiles[0]).not.toMatch(/git clone|COPY |ARG /);
    expect(mockProfileStore.get).not.toHaveBeenCalled();
    expect(mockProfileStore.setWarmImage).not.toHaveBeenCalled();
    await expect(builder.buildEnvironmentImage(input, { publish: true })).rejects.toThrow('ACR');
    expect(mockDocker.buildImage).toHaveBeenCalledTimes(1);
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

    expect(result.tag).toBe('ewiacr.azurecr.io/autopod/test-app:latest');
    expect(result.digest).toBe('sha256:abc123');
    expect(result.size).toBe(512 * 1_048_576);
    expect(result.buildDuration).toBeGreaterThanOrEqual(0);

    // Should push both latest and timestamped tags
    expect(mockAcr.push).toHaveBeenCalledTimes(2);
    expect(mockAcr.push).toHaveBeenCalledWith('autopod/test-app:latest');

    // Should update profile in DB
    expect(mockProfileStore.setWarmImage).toHaveBeenCalledWith(
      'test-app',
      'ewiacr.azurecr.io/autopod/test-app:latest',
      expect.any(String),
    );
  });

  it('acr-base-is-qualified-and-pinned', async () => {
    const { mockDocker, mockAcr, mockProfileStore, dockerfiles } = createMockDeps();
    const builder = new ImageBuilder({
      docker: mockDocker,
      acr: mockAcr,
      profileStore: mockProfileStore,
    });

    await builder.buildWarmImage(mockProfile({ template: 'node22-pw' }));

    expect(mockAcr.pullPinned).toHaveBeenCalledWith('autopod-node22-pw:latest');
    expect(dockerfiles).toEqual([
      expect.stringContaining('FROM ewiacr.azurecr.io/autopod-node22-pw@sha256:base-digest'),
    ]);
    expect(mockDocker.buildImage).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ platform: 'linux/amd64' }),
    );
  });

  it('unresolved-acr-base-fails-actionably', async () => {
    const { mockDocker, mockAcr, mockProfileStore } = createMockDeps();
    vi.mocked(mockAcr.pullPinned).mockRejectedValueOnce(new Error('registry access denied'));
    const builder = new ImageBuilder({
      docker: mockDocker,
      acr: mockAcr,
      profileStore: mockProfileStore,
    });

    await expect(builder.buildWarmImage(mockProfile({ template: 'node22-pw' }))).rejects.toThrow(
      'template "node22-pw" (ewiacr.azurecr.io/autopod-node22-pw:latest): registry access denied',
    );
    expect(mockDocker.buildImage).not.toHaveBeenCalled();
  });

  it('local-base-behavior-is-preserved', async () => {
    const { mockDocker, mockProfileStore, dockerfiles } = createMockDeps();
    const builder = new ImageBuilder({
      docker: mockDocker,
      acr: null,
      profileStore: mockProfileStore,
    });

    const result = await builder.buildWarmImage(mockProfile());

    expect(result.tag).toBe('autopod/test-app:latest');
    expect(dockerfiles).toEqual([expect.stringContaining('FROM autopod-node22:latest')]);
    expect(mockProfileStore.setWarmImage).toHaveBeenCalledWith(
      'test-app',
      'autopod/test-app:latest',
      expect.any(String),
    );
    expect(mockDocker.buildImage).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ platform: undefined }),
    );
  });

  it('builds ACR warm images for the sandbox amd64 platform', async () => {
    const { mockDocker, mockAcr, mockProfileStore } = createMockDeps();
    const builder = new ImageBuilder({
      docker: mockDocker,
      acr: mockAcr,
      profileStore: mockProfileStore,
    });

    await builder.buildWarmImage(mockProfile());

    expect(mockDocker.buildImage).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ platform: 'linux/amd64' }),
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

  it('passes an ADO Entra token as a bearer build arg', async () => {
    const { mockDocker, mockAcr, mockProfileStore } = createMockDeps();
    const builder = new ImageBuilder({
      docker: mockDocker,
      acr: mockAcr,
      profileStore: mockProfileStore,
    });

    await builder.buildWarmImage(mockProfile(), { gitEntraToken: 'entra-token' });

    expect(mockDocker.buildImage).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        buildargs: { GIT_ENTRA_TOKEN: 'entra-token' },
      }),
    );
  });

  it('does not pass build args when no git auth or registryPat is provided', async () => {
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
