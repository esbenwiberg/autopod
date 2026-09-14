import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { rowToProfile } from '../profiles/profile-store.js';
import { createTestDb, insertTestProfile } from '../test-utils/mock-helpers.js';
import { createConfigurationStore } from './configuration-store.js';
import { configurationDigest } from './launch-resolver.js';
import { applyLegacyProfileMigration } from './legacy-profile-migration-apply.js';
import {
  LEGACY_PROFILE_FIELD_OWNERS,
  previewLegacyProfileMigration,
} from './legacy-profile-migration.js';

describe('legacy profile conversion preview', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = createTestDb();
  });
  afterEach(() => {
    db.close();
  });
  function profile(name = 'legacy') {
    insertTestProfile(db, { name });
    const row = db.prepare('SELECT * FROM profiles WHERE name=?').get(name) as Record<
      string,
      unknown
    >;
    return {
      ...rowToProfile(row),
      providerAccountId: 'account',
      providerFailover: { targets: [], maxHops: 0 },
      testCommand: 'npm test',
    };
  }
  it('covers every profile field and preserves different setups in one repository', () => {
    const a = profile('one');
    const b = { ...a, name: 'two', buildCommand: 'npm run other', buildWorkDir: 'packages/app' };
    expect(Object.keys(a).sort()).toEqual(Object.keys(LEGACY_PROFILE_FIELD_OWNERS).sort());
    const result = previewLegacyProfileMigration([a, b]);
    expect(result.blockers).toEqual([]);
    const store = createConfigurationStore(db);
    store.writeBatch(result.entities);
    expect(store.list('repository')).toHaveLength(1);
    const repo = store.list('repository')[0];
    expect(repo?.payload.usualProfileId).toBeNull();
    expect(repo?.payload.setups.map((s) => s.buildCommand)).toEqual([
      'npm run build',
      'npm run other',
    ]);
    expect(store.list('environment')).toHaveLength(1);
    expect(store.list('profile')).toHaveLength(2);
    expect(result.bindings[0]?.memoryScope.repositoryId).toBe(
      result.bindings[1]?.memoryScope.repositoryId,
    );
    expect(result.bindings[0]?.setupId).not.toBe(result.bindings[1]?.setupId);
    expect(db.prepare('SELECT COUNT(*) AS n FROM profiles').get()).toEqual({ n: 1 });
  });
  it('blocks unavailable deployment while reporting retired integrations', () => {
    const source = {
      ...profile(),
      deployment: { enabled: true, env: {} },
      testPipeline: {
        enabled: true,
        testRepo: 'https://dev.azure.com/example/test/_git/fixture',
        testPipelineId: 1,
      },
      actionPolicy: {
        enabledGroups: ['custom' as const],
        sanitization: { preset: 'standard' as const },
        customActions: [
          {
            name: 'legacy_http',
            description: 'Retired fixture action',
            group: 'custom' as const,
            handler: 'http' as const,
            params: {},
            endpoint: {
              url: 'https://example.test/action',
              method: 'GET' as const,
              auth: { type: 'bearer' as const, secret: 'legacy-fixture-secret' },
            },
            response: { fields: [] },
          },
        ],
      },
    };
    const result = previewLegacyProfileMigration([source]);
    expect(result.blockers).toEqual([
      { profile: 'legacy', field: 'deployment', code: 'DEPLOYMENT_ISOLATION_UNAVAILABLE' },
    ]);
    expect(result.warnings).toEqual(
      expect.arrayContaining([
        { profile: 'legacy', code: 'TEST_PIPELINE_RETIRED' },
        { profile: 'legacy', code: 'CUSTOM_ACTIONS_RETIRED' },
      ]),
    );
    expect(JSON.stringify(result)).not.toContain('legacy-fixture-secret');
    expect(() =>
      applyLegacyProfileMigration({
        db,
        store: createConfigurationStore(db),
        readProfiles: () => [source],
        bindings: {},
        expectedDigest: configurationDigest(result),
      }),
    ).toThrow('blockers');
    expect(db.prepare('SELECT COUNT(*) AS n FROM configuration_conversions').get()).toEqual({
      n: 0,
    });
  });
  it('converts deployment only with an explicit published-default target mapping', () => {
    const source = {
      ...profile(),
      deployment: { enabled: true, env: {} },
      actionPolicy: {
        enabledGroups: ['deploy' as const],
        sanitization: { preset: 'standard' as const },
      },
    };
    const result = previewLegacyProfileMigration([source], {
      deploymentByProfile: {
        legacy: {
          source: 'published-default',
          targetId: 'production',
          allowedScripts: ['scripts/deploy.sh'],
        },
      },
    });
    expect(result.blockers).toEqual([]);
    const store = createConfigurationStore(db);
    store.writeBatch(result.entities);
    expect(store.list('repository')[0]?.payload.setups[0]?.integrations.deployment).toEqual({
      enabled: true,
      source: 'published-default',
      targetId: 'production',
      allowedScripts: ['scripts/deploy.sh'],
      env: {},
    });
    expect(previewLegacyProfileMigration([source]).blockers).toContainEqual({
      profile: 'legacy',
      field: 'deployment',
      code: 'DEPLOYMENT_ISOLATION_UNAVAILABLE',
    });
  });
  it('retires a specialized profile into a reusable profile while preserving its setup', () => {
    const reusable = profile('guardian');
    const deploy = {
      ...profile('guardian-deploy'),
      providerAccountId: null,
      deployment: { enabled: true, env: {} },
      pimActivations: [
        {
          type: 'azure-role' as const,
          roleDefinitionId: '00000000-0000-0000-0000-000000000001',
          scope: '/subscriptions/example/resourceGroups/deploy',
        },
      ],
      actionPolicy: {
        enabledGroups: ['deploy' as const, 'azure-pim' as const],
        sanitization: { preset: 'standard' as const },
      },
    };
    const result = previewLegacyProfileMigration([reusable, deploy], {
      deploymentByProfile: {
        'guardian-deploy': {
          source: 'published-default',
          targetId: 'production',
          allowedScripts: ['scripts/deploy.sh'],
        },
      },
      profileReplacementByProfile: { 'guardian-deploy': 'guardian' },
    });
    expect(result.blockers).toEqual([]);
    expect(result.warnings).toContainEqual({
      profile: 'guardian-deploy',
      code: 'PROFILE_REPLACED',
    });
    const store = createConfigurationStore(db);
    store.writeBatch(result.entities);
    expect(store.list('profile')).toHaveLength(1);
    expect(store.list('repository')[0]?.payload.setups).toHaveLength(2);
    expect(result.bindings.find((b) => b.legacyProfileName === 'guardian-deploy')?.profileId).toBe(
      result.bindings.find((b) => b.legacyProfileName === 'guardian')?.profileId,
    );
  });
  it('rejects a replacement profile from another repository', () => {
    const reusable = profile('guardian');
    const deploy = {
      ...profile('guardian-deploy'),
      repoUrl: 'https://github.com/example/other',
    };
    expect(
      previewLegacyProfileMigration([reusable, deploy], {
        profileReplacementByProfile: { 'guardian-deploy': 'guardian' },
      }).blockers,
    ).toContainEqual({
      profile: 'guardian-deploy',
      field: 'profileReplacement',
      code: 'REPLACEMENT_REPOSITORY_MISMATCH',
    });
  });
  it('preserves reviewed ADO and log read replacements in repository setups', () => {
    const source = {
      ...profile(),
      actionPolicy: {
        enabledGroups: ['ado-code' as const],
        sanitization: { preset: 'standard' as const },
      },
    };
    const serviceAccess = [
      {
        id: 'teamplanner-source',
        service: 'ado' as const,
        organization: 'company',
        project: 'TeamPlanner',
        repository: 'TeamPlanner',
        operations: ['code.file' as const, 'code.search' as const],
      },
    ];
    const result = previewLegacyProfileMigration([source], {
      serviceAccessByProfile: { legacy: serviceAccess },
    });
    expect(result.blockers).toEqual([]);
    const store = createConfigurationStore(db);
    store.writeBatch(result.entities);
    expect(store.list('repository')[0]?.payload.setups[0]?.integrations.serviceAccess).toEqual(
      serviceAccess,
    );
    expect(store.list('workflow')[0]?.payload).not.toHaveProperty('advancedActionPolicyId');
  });
  it('allows an explicit empty replacement to retire unscoped service access', () => {
    const source = {
      ...profile(),
      actionPolicy: {
        enabledGroups: ['ado-code' as const],
        sanitization: { preset: 'standard' as const },
      },
    };
    const result = previewLegacyProfileMigration([source], {
      serviceAccessByProfile: { legacy: [] },
    });
    expect(result.blockers).toEqual([]);
    expect(result.warnings).toContainEqual({
      profile: 'legacy',
      code: 'SCOPED_ACCESS_RETIRED',
    });
  });
  it('reports custom actions as intentionally retired without blocking conversion', () => {
    const source = {
      ...profile(),
      actionPolicy: {
        enabledGroups: ['custom' as const],
        sanitization: { preset: 'standard' as const },
      },
    };
    const result = previewLegacyProfileMigration([source], {
      serviceAccessByProfile: { legacy: [] },
    });
    expect(result.blockers).toEqual([]);
    expect(result.warnings).toContainEqual({
      profile: 'legacy',
      code: 'CUSTOM_ACTIONS_RETIRED',
    });
    const store = createConfigurationStore(db);
    store.writeBatch(result.entities);
    expect(store.list('workflow')[0]?.payload).not.toHaveProperty('advancedActionPolicyId');
  });
  it('resolves inheritance with explicit empty replacements before splitting', () => {
    const parent = {
      ...profile('parent'),
      customInstructions: 'Parent instructions',
      skills: [{ name: 'parent-skill', source: { type: 'builtin' as const } }],
    };
    const child = {
      ...parent,
      name: 'child',
      extends: 'parent',
      buildCommand: null,
      customInstructions: 'Child instructions',
      skills: [],
      mergeStrategy: { skills: 'replace' as const },
    };
    const result = previewLegacyProfileMigration([parent, child]);
    expect(result.blockers).toEqual([]);
    const store = createConfigurationStore(db);
    store.writeBatch(result.entities);
    const binding = result.bindings.find((b) => b.legacyProfileName === 'child');
    const p = store.get('profile', binding?.profileId ?? 'missing');
    const pack = store.get('toolPack', p.payload.toolPackIds[0] ?? 'missing');
    expect(pack.payload.skills).toEqual([]);
    expect(pack.payload.instructions[0]?.content).toBe('Parent instructions\n\nChild instructions');
  });
  it('requires the account failover default to be discovered before flattening it', () => {
    const p = { ...profile(), providerFailover: null };
    expect(previewLegacyProfileMigration([p]).blockers).toContainEqual({
      profile: 'legacy',
      field: 'providerFailover',
      code: 'ACCOUNT_FAILOVER_MAPPING_REQUIRED',
    });
    expect(
      previewLegacyProfileMigration([p], { accountFailover: { account: null } }).blockers,
    ).toEqual([]);
    const withFallback = previewLegacyProfileMigration([p], {
      accountFailover: {
        account: {
          targets: [{ providerAccountId: 'alternate', runtime: 'codex', model: 'gpt-5.5' }],
        },
      },
    });
    expect(withFallback.blockers).toEqual([]);
    const store = createConfigurationStore(db);
    store.writeBatch(withFallback.entities);
    expect(store.list('ai')[0]?.payload.main.failover[0]?.providerAccountId).toBe('alternate');
  });
  it('does not emit credentials in a blocked or resolved preview', () => {
    const p = {
      ...profile(),
      providerAccountId: null,
      providerCredentials: { provider: 'anthropic' as const, apiKey: 'fixture-only-do-not-store' },
      githubPat: 'fixture-github-secret',
      registryPat: 'fixture-registry-secret',
    };
    const blocked = previewLegacyProfileMigration([p]);
    expect(blocked.entities).toEqual([]);
    expect(blocked.blockers).toContainEqual({
      profile: 'legacy',
      field: 'providerAccountId',
      code: 'ACCOUNT_MAPPING_REQUIRED',
    });
    expect(JSON.stringify(blocked)).not.toContain('fixture-');
    const mapped = previewLegacyProfileMigration([p], {
      accountByProfile: { legacy: 'account' },
      registryCredentialByProfile: { legacy: 'feed-secret-ref' },
    });
    expect(mapped.blockers).toEqual([]);
    expect(JSON.stringify(mapped)).not.toContain('fixture-');
    expect(mapped.warnings).toContainEqual({
      profile: 'legacy',
      code: 'LEGACY_GITHUB_PAT_RETAINED_IN_BACKUP_ONLY',
    });
  });
  it('requires explicit trust/action/PIM mappings rather than widening scope', () => {
    const a = profile('trusted');
    const b = { ...a, name: 'untrusted', trustedSource: false };
    a.trustedSource = true;
    const conflicting = previewLegacyProfileMigration([a, b]);
    expect(conflicting.entities).toEqual([]);
    expect(conflicting.blockers.some((b) => b.code === 'CONFLICTING_REPOSITORY_TRUST')).toBe(true);
    const p = {
      ...a,
      pimActivations: [{ type: 'group' as const, groupId: '00000000-0000-0000-0000-000000000001' }],
    };
    expect(
      previewLegacyProfileMigration([p]).blockers.some(
        (b) => b.code === 'EXACT_PIM_MAPPING_REQUIRED',
      ),
    ).toBe(true);
  });
  it('converts legacy code intelligence into pinned environment tools and one tool pack', () => {
    const source = {
      ...profile(),
      template: 'dotnet10' as const,
      codeIntelligence: { serena: true, roslynCodeLens: true },
    };
    expect(previewLegacyProfileMigration([source]).blockers).toEqual(
      expect.arrayContaining([
        {
          profile: 'legacy',
          field: 'codeIntelligence.serena',
          code: 'CODE_INTELLIGENCE_VERSION_REQUIRED',
        },
        {
          profile: 'legacy',
          field: 'codeIntelligence.roslynCodeLens',
          code: 'CODE_INTELLIGENCE_VERSION_REQUIRED',
        },
      ]),
    );
    const result = previewLegacyProfileMigration([source], {
      codeIntelligenceVersions: { serena: '1.7.0', roslynCodeLens: '2.18.0' },
    });
    expect(result.blockers).toEqual([]);
    const store = createConfigurationStore(db);
    store.writeBatch(result.entities);
    expect(store.list('environment')[0]?.payload).toMatchObject({
      tools: [
        { name: 'pip:serena-agent', version: '1.7.0' },
        { name: 'dotnet:RoslynCodeLens.Mcp', version: '2.18.0' },
      ],
      capabilities: expect.arrayContaining(['serena', 'roslyn-codelens']),
    });
    expect(store.list('toolPack')[0]?.payload).toMatchObject({
      requiredCapabilities: ['serena', 'roslyn-codelens'],
      mcpServers: [
        { name: 'serena', transport: { command: 'serena' } },
        { name: 'roslyn-codelens', transport: { command: 'roslyn-codelens-mcp' } },
      ],
    });
  });
  it('requires explicit normalization for a legacy remote containing user-info', () => {
    const source = {
      ...profile(),
      repoUrl: 'https://organization@dev.azure.com/organization/project/_git/repository',
    };
    expect(previewLegacyProfileMigration([source]).blockers).toContainEqual({
      profile: 'legacy',
      field: 'repoUrl',
      code: 'REMOTE_CREDENTIAL_REVIEW_REQUIRED',
    });
    const result = previewLegacyProfileMigration([source], {
      remoteByProfile: {
        legacy: 'https://dev.azure.com/organization/project/_git/repository',
      },
    });
    expect(result.blockers).toEqual([]);
    const store = createConfigurationStore(db);
    store.writeBatch(result.entities);
    expect(store.list('repository')[0]?.payload.remote).toBe(
      'https://dev.azure.com/organization/project/_git/repository',
    );
  });
  it('rejects broken chains and keeps scratch profiles repository-free', () => {
    const a = profile();
    expect(previewLegacyProfileMigration([{ ...a, extends: 'missing' }]).blockers[0]?.code).toBe(
      'INVALID_LEGACY_CHAIN',
    );
    const result = previewLegacyProfileMigration([
      { ...a, repoUrl: null, outputMode: 'artifact', pod: null },
    ]);
    expect(result.blockers).toEqual([]);
    expect(result.entities.some((e) => e.kind === 'repository')).toBe(false);
    expect(result.bindings[0]?.repositoryId).toBeNull();
  });
  it('applies a reviewed conversion atomically and detects source/mapping drift', () => {
    const p = profile();
    const store = createConfigurationStore(db);
    const manifest = previewLegacyProfileMigration([p]);
    const input = {
      db,
      store,
      readProfiles: () => [p],
      bindings: {},
      expectedDigest: configurationDigest(manifest),
    };
    expect(() => applyLegacyProfileMigration({ ...input, expectedDigest: 'stale' })).toThrow(
      'changed',
    );
    expect(store.list('profile')).toHaveLength(0);
    expect(applyLegacyProfileMigration(input).applied).toBe(true);
    expect(applyLegacyProfileMigration(input).applied).toBe(false);
    expect(store.list('profile')).toHaveLength(1);
    expect(db.prepare('SELECT COUNT(*) AS n FROM configuration_conversions').get()).toEqual({
      n: 1,
    });
  });
});
