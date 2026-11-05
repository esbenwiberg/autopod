import { describe, expect, it } from 'vitest';
import {
  aiPresetSchema,
  configurationUrlSchema,
  githubAccessPresetSchema,
  launchOverridesSchema,
  launchProfileSchema,
  launchRequestSchema,
  repositoryConfigSchema,
} from './launch-config.schema.js';

describe('composable launch contracts', () => {
  it('preserves absent advisor and accepts only strict Advisor modes', () => {
    const main = { providerAccountId: 'main', runtime: 'claude', model: 'sonnet' };
    expect(aiPresetSchema.parse({ main })).not.toHaveProperty('advisor');
    expect(launchOverridesSchema.parse({ ai: { main } })).toMatchObject({
      ai: { main },
    });
    for (const advisor of [
      { mode: 'follow-main' },
      { mode: 'follow-reviewer' },
      {
        mode: 'independent',
        route: { ...main, failover: [{ ...main, providerAccountId: 'fallback' }], maxHops: 1 },
      },
    ]) {
      expect(aiPresetSchema.safeParse({ main, advisor }).success).toBe(true);
      expect(launchOverridesSchema.parse({ ai: { advisor } }).ai?.advisor?.mode).toBe(advisor.mode);
    }
    for (const advisor of [
      null,
      {},
      { mode: 'unknown' },
      { mode: 'independent' },
      { mode: 'follow-main', route: main },
      { mode: 'follow-reviewer', extra: true },
      { mode: 'independent', route: { ...main, apiKey: 'secret' } },
      { mode: 'independent', route: { ...main, failover: [{ ...main, maxHops: 1 }] } },
    ])
      expect(aiPresetSchema.safeParse({ main, advisor }).success).toBe(false);
  });
  it('distinguishes defaults, clearing and empty collections', () => {
    const base = { repositoryId: 'repo', task: 'Fix tests' };
    const missing = launchRequestSchema.parse(base);
    expect(missing.selections).toBeUndefined();
    const clear = launchRequestSchema.parse({
      ...base,
      selections: { githubAccessId: null, toolPackIds: [] },
    });
    expect(clear.selections).toEqual({ githubAccessId: null, toolPackIds: [] });
    expect(launchRequestSchema.safeParse({ ...base, selections: { aiId: null } }).success).toBe(
      false,
    );
    expect(launchOverridesSchema.parse({ workflow: { tokenBudget: null }, pim: [] })).toEqual({
      workflow: { tokenBudget: null },
      pim: [],
    });
    expect(launchOverridesSchema.parse({ execution: { main: { memoryGb: 8 } } })).toEqual({
      execution: { main: { memoryGb: 8 } },
    });
  });
  it('refuses legacy inheritance, credentials and authority overrides', () => {
    const profile = { environmentId: 'env', aiId: 'ai', workflowId: 'flow' };
    expect(launchProfileSchema.safeParse({ ...profile, extends: 'parent' }).success).toBe(false);
    expect(
      launchOverridesSchema.safeParse({ repositorySetup: { trustedSource: true } }).success,
    ).toBe(false);
    expect(launchOverridesSchema.safeParse({ execution: { trustedSource: true } }).success).toBe(
      false,
    );
    expect(
      aiPresetSchema.safeParse({
        main: {
          providerAccountId: 'account',
          runtime: 'claude',
          model: 'sonnet',
          apiKey: 'not-a-real-key',
        },
      }).success,
    ).toBe(false);
  });
  it('requires one source variant and bounds goal objectives', () => {
    expect(
      launchRequestSchema.safeParse({ repositoryId: 'repo', emptyWorkspace: true, task: 'Fix' })
        .success,
    ).toBe(false);
    expect(launchRequestSchema.safeParse({ emptyWorkspace: true, task: 'Scratch' }).success).toBe(
      false,
    );
    expect(
      launchRequestSchema.safeParse({ emptyWorkspace: true, profileId: 'scratch', task: 'Scratch' })
        .success,
    ).toBe(true);
    expect(
      launchRequestSchema.safeParse({
        repositoryId: 'repo',
        intent: 'goal',
        task: 'a'.repeat(4001),
      }).success,
    ).toBe(false);
  });
  it('keeps workflow and branch scope independent and has no delivery operations', () => {
    const access = githubAccessPresetSchema.parse({
      rules: [
        {
          id: 'r',
          repositories: { mode: 'current' },
          operations: ['workflows.dispatch'],
          workflows: { mode: 'all' },
          branches: { mode: 'selected', names: ['main'] },
        },
      ],
    });
    expect(access.rules[0]?.branches).toEqual({ mode: 'selected', names: ['main'] });
    expect(
      githubAccessPresetSchema.safeParse({
        rules: [{ ...access.rules[0], operations: ['prs.create'] }],
      }).success,
    ).toBe(false);
  });
  it('rejects malformed setup identities and unsafe remote URLs', () => {
    const repo = {
      provider: 'github',
      remote: 'https://github.com/owner/repo',
      defaultSetupId: 'main',
      setups: [{ id: 'main', name: 'Main' }],
    };
    expect(repositoryConfigSchema.safeParse(repo).success).toBe(true);
    expect(repositoryConfigSchema.safeParse({ ...repo, defaultSetupId: 'absent' }).success).toBe(
      false,
    );
    expect(repositoryConfigSchema.safeParse({ ...repo, trustedSetupIds: ['absent'] }).success).toBe(
      false,
    );
    for (const remote of [
      'https://user:password@github.com/owner/repo',
      'https://github.com/a/b?token=x',
      'file:///tmp/repo',
    ]) {
      expect(configurationUrlSchema.safeParse(remote).success).toBe(false);
    }
    expect(
      repositoryConfigSchema.safeParse({
        ...repo,
        setups: [{ id: 'main', name: 'Main', buildWorkDir: '../elsewhere' }],
      }).success,
    ).toBe(false);
  });
});
