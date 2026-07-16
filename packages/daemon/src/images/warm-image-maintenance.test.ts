import type { Profile } from '@autopod/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { logger } from '../test-utils/mock-helpers.js';
import {
  type WarmImageMaintenanceDeps,
  createWarmImageMaintenanceJob,
} from './warm-image-maintenance.js';

function mockProfile(overrides: Partial<Profile> = {}): Profile {
  return {
    name: 'test-app',
    repoUrl: 'https://github.com/org/repo',
    defaultBranch: 'main',
    template: 'node22',
    buildCommand: 'npm run build',
    startCommand: 'npm start',
    buildWorkDir: null,
    healthPath: '/',
    healthTimeout: 120,
    smokePages: [],
    maxValidationAttempts: 3,
    defaultModel: 'claude-opus-4-5',
    reviewerModel: null,
    defaultRuntime: 'claude',
    executionTarget: 'sandbox',
    customInstructions: null,
    agentDonePrompt: null,
    escalation: null,
    extends: null,
    workerProfile: null,
    warmImageTag: null,
    warmImageBuiltAt: null,
    mcpServers: [],
    claudeMdSections: [],
    skills: [],
    networkPolicy: null,
    actionPolicy: null,
    pod: null,
    outputMode: 'pr',
    modelProvider: 'anthropic',
    providerCredentials: null,
    testCommand: null,
    validationSetupCommand: null,
    buildEnv: null,
    buildTimeout: 300,
    testTimeout: 600,
    lintCommand: null,
    lintTimeout: 120,
    sastCommand: null,
    sastTimeout: 300,
    mergePollIntervalSec: null,
    preflightConflictPolicy: null,
    prProvider: 'github',
    adoPat: null,
    adoPatExpiresAt: null,
    githubPat: null,
    githubPatExpiresAt: null,
    openrouterApiKey: null,
    privateRegistries: [],
    registryPat: null,
    registryPatExpiresAt: null,
    branchPrefix: 'autopod/',
    containerMemoryGb: null,
    tokenBudget: null,
    tokenBudgetWarnAt: 0.8,
    tokenBudgetPolicy: 'soft',
    maxBudgetExtensions: null,
    hasWebUi: true,
    issueWatcherEnabled: false,
    issueWatcherLabelPrefix: 'autopod',
    pimActivations: null,
    mergeStrategy: {},
    sidecars: null,
    trustedSource: null,
    testPipeline: null,
    securityScan: null,
    codeIntelligence: null,
    deployment: null,
    skipValidationPhases: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function createDeps(
  profiles: Profile[],
  overrides: Partial<WarmImageMaintenanceDeps['imageBuilder']> = {},
): WarmImageMaintenanceDeps {
  return {
    profileStore: {
      list: vi.fn(() => profiles),
    },
    imageBuilder: {
      isStale: vi.fn(() => true),
      buildWarmImage: vi.fn(async (profile: Profile) => ({
        tag: `example.azurecr.io/autopod/${profile.name}:latest`,
        digest: 'sha256:abc123',
        size: 512 * 1_048_576,
        buildDuration: 12.3,
      })),
      ...overrides,
    },
    logger,
    runOnStart: false,
  };
}

describe('WarmImageMaintenanceJob', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('builds stale sandbox profiles with daemon GitHub credentials', async () => {
    const profile = mockProfile({
      githubPat: 'ghp_secret',
      registryPat: 'registry_secret',
    });
    const deps = {
      ...createDeps([profile]),
      githubAuth: {
        resolveCredential: vi.fn(async () => ({ token: 'daemon-gh-token', username: 'x-access-token' })),
        getStatus: vi.fn(),
      },
    };
    const job = createWarmImageMaintenanceJob(deps);

    const result = await job.runOnce();

    expect(result.built).toBe(1);
    expect(result.failed).toBe(0);
    expect(deps.imageBuilder.buildWarmImage).toHaveBeenCalledWith(profile, {
      gitPat: 'daemon-gh-token',
      registryPat: 'registry_secret',
    });
  });

  it('skips fresh eligible profiles and local profiles outside sandbox scope', async () => {
    const freshSandbox = mockProfile({
      name: 'fresh-sandbox',
      warmImageTag: 'example.azurecr.io/autopod/fresh-sandbox:latest',
      warmImageBuiltAt: new Date().toISOString(),
    });
    const localProfile = mockProfile({
      name: 'local-app',
      executionTarget: 'local',
    });
    const deps = createDeps([freshSandbox, localProfile], {
      isStale: vi.fn(() => false),
    });
    const job = createWarmImageMaintenanceJob(deps);

    const result = await job.runOnce();

    expect(result.checked).toBe(2);
    expect(result.eligible).toBe(1);
    expect(result.fresh).toBe(1);
    expect(result.skipped.outside_scope).toBe(1);
    expect(deps.imageBuilder.buildWarmImage).not.toHaveBeenCalled();
  });

  it('keeps previously warmed local profiles fresh in sandbox scope', async () => {
    const profile = mockProfile({
      executionTarget: 'local',
      warmImageTag: 'example.azurecr.io/autopod/local-app:latest',
      warmImageBuiltAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString(),
    });
    const deps = createDeps([profile]);
    const job = createWarmImageMaintenanceJob(deps);

    const result = await job.runOnce();

    expect(result.eligible).toBe(1);
    expect(result.built).toBe(1);
  });

  it('can warm every repo-backed profile when scope is all', async () => {
    const profile = mockProfile({ executionTarget: 'local' });
    const deps = createDeps([profile]);
    const job = createWarmImageMaintenanceJob({ ...deps, scope: 'all' });

    const result = await job.runOnce();

    expect(result.eligible).toBe(1);
    expect(result.built).toBe(1);
  });

  it('continues after one profile build fails', async () => {
    const failing = mockProfile({ name: 'failing' });
    const succeeding = mockProfile({ name: 'succeeding' });
    const buildWarmImage = vi
      .fn()
      .mockRejectedValueOnce(new Error('build failed'))
      .mockResolvedValueOnce({
        tag: 'example.azurecr.io/autopod/succeeding:latest',
        digest: 'sha256:abc123',
        size: 1,
        buildDuration: 1,
      });
    const deps = createDeps([failing, succeeding], { buildWarmImage });
    const job = createWarmImageMaintenanceJob(deps);

    const result = await job.runOnce();

    expect(result.failed).toBe(1);
    expect(result.built).toBe(1);
    expect(buildWarmImage).toHaveBeenCalledTimes(2);
  });

  it('runs on an interval and stops cleanly', async () => {
    vi.useFakeTimers();
    const profile = mockProfile();
    const deps = createDeps([profile]);
    const job = createWarmImageMaintenanceJob({ ...deps, intervalMs: 1000, runOnStart: false });

    job.start();
    expect(deps.imageBuilder.buildWarmImage).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1000);
    expect(deps.imageBuilder.buildWarmImage).toHaveBeenCalledOnce();

    job.stop();
    await vi.advanceTimersByTimeAsync(2000);
    expect(deps.imageBuilder.buildWarmImage).toHaveBeenCalledOnce();
  });
});
