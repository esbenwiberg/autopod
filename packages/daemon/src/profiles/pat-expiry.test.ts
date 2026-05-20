import type { Profile } from '@autopod/shared';
import { describe, expect, it } from 'vitest';
import { findExpiredPat } from './pat-expiry.js';

function makeProfile(overrides: Partial<Profile> = {}): Profile {
  return {
    name: 'test-profile',
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
    defaultModel: 'opus',
    reviewerModel: null,
    defaultRuntime: 'claude',
    executionTarget: 'local',
    customInstructions: null,
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
    buildEnv: null,
    buildTimeout: 300,
    testTimeout: 600,
    lintCommand: null,
    lintTimeout: 120,
    sastCommand: null,
    sastTimeout: 300,
    mergePollIntervalSec: null,
    prProvider: 'github',
    adoPat: null,
    adoPatExpiresAt: null,
    githubPat: null,
    githubPatExpiresAt: null,
    privateRegistries: [],
    registryPat: null,
    registryPatExpiresAt: null,
    branchPrefix: 'autopod/',
    containerMemoryGb: null,
    version: 1,
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
    evaluatePlan: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

const now = new Date(2026, 4, 20, 12, 0, 0);

describe('PAT expiry checks', () => {
  it('returns null when expiry metadata is missing', () => {
    expect(findExpiredPat(makeProfile({ githubPat: 'ghp_secret' }), now)).toBeNull();
  });

  it('ignores a future GitHub PAT expiry', () => {
    const profile = makeProfile({ githubPat: 'ghp_secret', githubPatExpiresAt: '2026-05-21' });
    expect(findExpiredPat(profile, now)).toBeNull();
  });

  it('finds an expired selected GitHub PAT', () => {
    const profile = makeProfile({ githubPat: 'ghp_secret', githubPatExpiresAt: '2026-05-19' });
    expect(findExpiredPat(profile, now)).toEqual({
      field: 'githubPatExpiresAt',
      label: 'GitHub PAT',
      expiresAt: '2026-05-19',
    });
  });

  it('finds an expired selected ADO PAT', () => {
    const profile = makeProfile({
      prProvider: 'ado',
      adoPat: 'ado_secret',
      adoPatExpiresAt: '2026-05-19',
    });
    expect(findExpiredPat(profile, now)?.label).toBe('ADO PAT');
  });

  it('finds an expired registry PAT when private registries are configured', () => {
    const profile = makeProfile({
      privateRegistries: [{ type: 'npm', url: 'https://registry.example.com' }],
      registryPat: 'registry_secret',
      registryPatExpiresAt: '2026-05-19',
    });
    expect(findExpiredPat(profile, now)?.label).toBe('Registry PAT');
  });

  it('uses ADO PAT expiry when registry auth falls back to ADO', () => {
    const profile = makeProfile({
      privateRegistries: [{ type: 'nuget', url: 'https://pkgs.dev.azure.com/org/feed' }],
      adoPat: 'ado_secret',
      adoPatExpiresAt: '2026-05-19',
    });
    expect(findExpiredPat(profile, now)?.label).toBe('ADO PAT used for registry auth');
  });
});
