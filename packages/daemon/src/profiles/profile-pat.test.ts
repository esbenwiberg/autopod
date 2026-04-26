import type { Profile } from '@autopod/shared';
import { describe, expect, it } from 'vitest';
import { selectGitPat } from './profile-pat.js';

function makeProfile(overrides: Partial<Profile>): Profile {
  return {
    name: 'p',
    repoUrl: null,
    defaultBranch: null,
    branchPrefix: null,
    runtime: 'claude',
    model: null,
    extends: null,
    stack: null,
    customStack: null,
    executionTarget: 'docker',
    networkPolicy: null,
    privateRegistries: [],
    registryPat: null,
    prProvider: null,
    adoPat: null,
    githubPat: null,
    actions: [],
    actionPolicy: null,
    skills: [],
    sections: [],
    mcpServers: [],
    buildCommand: null,
    healthCheckUrl: null,
    smokeTestPages: [],
    customInstructions: null,
    autoMerge: null,
    maxValidationAttempts: null,
    maxPrFixAttempts: null,
    autoPauseAfterEscalations: null,
    outputMode: null,
    testCommand: null,
    modelProvider: null,
    providerCredentials: null,
    timeoutMinutes: null,
    sastEnabled: null,
    sastTimeout: null,
    pimActivations: [],
    codeIntelligence: null,
    reviewerModel: null,
    ...overrides,
  } as Profile;
}

describe('selectGitPat', () => {
  it('returns adoPat when prProvider is ado, even if githubPat is also set', () => {
    const profile = makeProfile({ prProvider: 'ado', adoPat: 'ado-1', githubPat: 'gh-1' });
    expect(selectGitPat(profile)).toBe('ado-1');
  });

  it('returns githubPat when prProvider is github, even if adoPat is also set', () => {
    const profile = makeProfile({ prProvider: 'github', adoPat: 'ado-1', githubPat: 'gh-1' });
    expect(selectGitPat(profile)).toBe('gh-1');
  });

  it('prefers githubPat when prProvider is null and both PATs are set (GitHub-by-default fallback)', () => {
    // Regression guard: the old `adoPat ?? githubPat` chain picked the ADO PAT here, which
    // GitHub rejects with "Invalid username or token. Password authentication is not supported".
    const profile = makeProfile({ prProvider: null, adoPat: 'ado-1', githubPat: 'gh-1' });
    expect(selectGitPat(profile)).toBe('gh-1');
  });

  it('falls back to adoPat when prProvider is null and only adoPat is set', () => {
    const profile = makeProfile({ prProvider: null, adoPat: 'ado-1', githubPat: null });
    expect(selectGitPat(profile)).toBe('ado-1');
  });

  it('returns undefined when prProvider is ado but adoPat is missing', () => {
    const profile = makeProfile({ prProvider: 'ado', adoPat: null, githubPat: 'gh-1' });
    expect(selectGitPat(profile)).toBeUndefined();
  });

  it('returns undefined when no PATs are configured', () => {
    const profile = makeProfile({ prProvider: null, adoPat: null, githubPat: null });
    expect(selectGitPat(profile)).toBeUndefined();
  });
});
