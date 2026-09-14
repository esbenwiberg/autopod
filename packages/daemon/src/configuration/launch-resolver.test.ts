import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createTestConfiguration,
  insertConfigurationTestPod,
} from '../test-utils/configuration-helpers.js';
import { createTestDb } from '../test-utils/mock-helpers.js';
import { createConfigurationStore } from './configuration-store.js';
import { configurationDigest, resolveLaunch } from './launch-resolver.js';
import { createLaunchSnapshotRepository } from './launch-snapshot.js';
import { proposeLaunchProfile, saveLaunchProfile } from './save-launch-profile.js';

describe('launch resolution and snapshots', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = createTestDb();
  });
  afterEach(() => {
    db.close();
  });
  it('shares profile categories without sharing repository identity', async () => {
    const { services } = createTestConfiguration(db);
    const a = await resolveLaunch({ repositoryId: 'repo-a', task: 'Fix' }, services);
    const b = await resolveLaunch({ repositoryId: 'repo-b', task: 'Fix' }, services);
    expect(a.environment).toEqual(b.environment);
    expect(a.profileId).toBe(b.profileId);
    expect(a.githubAccess[0]?.repositoryIds).toEqual(['repo-a']);
    expect(b.githubAccess[0]?.repositoryIds).toEqual(['repo-b']);
    expect(a.digest).not.toBe(b.digest);
  });
  it('freezes task-specific handoff and context without adding them to a reusable profile', async () => {
    const { services, store } = createTestConfiguration(db);
    const work = {
      baseBranch: 'release',
      handoffInstructions: 'Follow this reviewed plan',
      specFiles: [],
      specContextFiles: [{ path: 'brief.md', content: 'Required behavior' }],
    };
    const launch = await resolveLaunch({ repositoryId: 'repo-a', task: 'Fix', work }, services);
    expect(launch.work).toEqual(work);
    const changed = await resolveLaunch(
      {
        repositoryId: 'repo-a',
        task: 'Fix',
        work: { ...work, handoffInstructions: 'Changed plan' },
      },
      services,
    );
    expect(changed.digest).not.toBe(launch.digest);
    const proposal = proposeLaunchProfile(launch, { profile: 'Reusable' }, store);
    expect(JSON.stringify(proposal)).not.toContain('Required behavior');
    await expect(
      resolveLaunch(
        {
          repositoryId: 'repo-a',
          task: 'Fix',
          work: { specContextFiles: [{ path: '../escape', content: '' }] },
        },
        services,
      ),
    ).rejects.toThrow();
  });
  it('rejects the legacy host deployment runner during preview', async () => {
    const { services, store } = createTestConfiguration(db);
    const repo = store.get('repository', 'repo-a');
    store.write({
      kind: 'repository',
      id: repo.id,
      name: repo.name,
      expectedRevision: repo.revision,
      payload: {
        ...repo.payload,
        setups: repo.payload.setups.map((setup) => ({
          ...setup,
          integrations: {
            ...setup.integrations,
            deployment: { enabled: true, env: {}, allowedScripts: ['deploy.sh'] },
          },
        })),
      },
    });
    await expect(
      resolveLaunch({ repositoryId: 'repo-a', task: 'Work' }, services),
    ).rejects.toMatchObject({ code: 'DEPLOYMENT_ISOLATION_UNAVAILABLE' });
  });
  it('rejects retired test-pipeline and advanced-action fields from composable entities', () => {
    const { services, store } = createTestConfiguration(db);
    const repo = store.get('repository', 'repo-a');
    const setup = repo.payload.setups[0];
    if (!setup) throw new Error('Missing fixture setup');
    expect(() =>
      store.write({
        kind: 'repository',
        id: repo.id,
        name: repo.name,
        expectedRevision: repo.revision,
        payload: {
          ...repo.payload,
          setups: repo.payload.setups.map((value) =>
            value.id === setup.id
              ? {
                  ...value,
                  integrations: {
                    ...value.integrations,
                    testPipeline: {
                      enabled: true,
                      testRepo: 'https://dev.azure.com/example/test/_git/fixture',
                      testPipelineId: 1,
                    },
                  },
                }
              : value,
          ),
        },
      }),
    ).toThrow();
    const workflow = store.get('workflow', 'flow');
    expect(() =>
      store.write({
        kind: 'workflow',
        id: workflow.id,
        name: workflow.name,
        expectedRevision: workflow.revision,
        payload: { ...workflow.payload, advancedActionPolicyId: 'old-actions' },
      }),
    ).toThrow();
    expect(services.store.get('repository', repo.id).revision).toBe(repo.revision);
  });
  it('preserves sidecar defaults when saving a profile and lets a launch explicitly clear them', async () => {
    const { services, store } = createTestConfiguration(db);
    const environment = store.get('environment', 'env');
    store.write({
      id: environment.id,
      kind: 'environment',
      name: environment.name,
      expectedRevision: environment.revision,
      payload: {
        ...environment.payload,
        sidecars: [
          {
            id: 'database',
            type: 'postgres',
            image: `postgres@sha256:${'a'.repeat(64)}`,
            startup: 'on-demand',
            version: '16',
            port: 5432,
          },
        ],
      },
    });
    const launch = await resolveLaunch(
      { repositoryId: 'repo-a', task: 'Develop', requiredSidecarIds: ['database'] },
      services,
    );
    const proposal = proposeLaunchProfile(launch, { profile: 'Database development' }, store);
    expect(proposal.writes.map((write) => write.kind)).toEqual(['profile']);
    const saved = saveLaunchProfile(db, store, proposal, proposal.digest);
    expect(saved.payload.requiredSidecarIds).toEqual(['database']);
    const next = await resolveLaunch(
      { repositoryId: 'repo-b', profileId: saved.id, task: 'Reuse' },
      services,
    );
    expect(next.requiredSidecarIds).toEqual(['database']);
    expect(Object.keys(next.resolvedExecution.sidecars)).toEqual(['database']);
    const cleared = await resolveLaunch(
      { repositoryId: 'repo-b', profileId: saved.id, task: 'No database', requiredSidecarIds: [] },
      services,
    );
    expect(cleared.resolvedExecution.sidecars).toEqual({});
  });
  it('replaces AI coherently and clears optional access', async () => {
    const { services, store } = createTestConfiguration(db);
    store.write({
      id: 'other-ai',
      kind: 'ai',
      name: 'Other AI',
      payload: {
        main: { providerAccountId: 'openai-account', runtime: 'codex', model: 'gpt-5.4' },
      },
    });
    const result = await resolveLaunch(
      {
        repositoryId: 'repo-a',
        task: 'Fix',
        selections: { aiId: 'other-ai', githubAccessId: null, toolPackIds: [] },
        overrides: { execution: { main: { memoryGb: 8 } }, pim: [] },
      },
      services,
    );
    expect(result.ai.main).toMatchObject({
      runtime: 'codex',
      providerAccountId: 'openai-account',
      model: 'gpt-5.4',
    });
    expect(result.githubAccess).toEqual([]);
    expect(result.execution.main).toEqual({ memoryGb: 8, cpus: null, storageGb: null });
    expect(result.provenance['execution.main']?.source).toBe('override');
  });
  it('does not silently discard commands, incompatible tools or unavailable credentials', async () => {
    const { services } = createTestConfiguration(db);
    await expect(
      resolveLaunch(
        {
          repositoryId: 'repo-a',
          task: 'Fix',
          overrides: { repositorySetup: { buildCommand: null } },
        },
        services,
      ),
    ).rejects.toThrow('buildCommand');
    await expect(
      resolveLaunch(
        {
          repositoryId: 'repo-a',
          task: 'Fix',
          overrides: { toolPacks: [{ requiredCapabilities: ['python'] }] },
        },
        services,
      ),
    ).rejects.toThrow('python');
    services.resolveAgentRoute = vi.fn(async () => {
      throw new Error('Account revoked');
    });
    await expect(resolveLaunch({ repositoryId: 'repo-a', task: 'Fix' }, services)).rejects.toThrow(
      'Account revoked',
    );
  });
  it('pins fetched tool content and rejects conflicting names', async () => {
    const { services } = createTestConfiguration(db);
    const pack = {
      skills: [{ name: 'test', source: { type: 'local', path: '/fixture/skill.md' } }],
    };
    const result = await resolveLaunch(
      { repositoryId: 'repo-a', task: 'Fix', overrides: { toolPacks: [pack, pack] } },
      services,
    );
    expect(services.skillContent).toHaveBeenCalledTimes(1);
    expect(result.toolContents['skill:test']?.content).toBe('# Fixed skill content');
    await expect(
      resolveLaunch(
        {
          repositoryId: 'repo-a',
          task: 'Fix',
          overrides: {
            toolPacks: [
              pack,
              { skills: [{ name: 'test', source: { type: 'inline', content: 'different' } }] },
            ],
          },
        },
        services,
      ),
    ).rejects.toThrow('Conflicting');
  });
  it('rejects a stale preview and edits made during asynchronous discovery', async () => {
    const { services, store } = createTestConfiguration(db);
    const request = { repositoryId: 'repo-a', task: 'Fix' };
    const preview = await resolveLaunch(request, services);
    const env = store.get('environment', 'env');
    store.write({
      ...env,
      expectedRevision: env.revision,
      payload: { ...env.payload, template: 'node24' },
    });
    await expect(
      resolveLaunch({ ...request, expectedDigest: preview.digest }, services),
    ).rejects.toThrow('after preview');
    services.githubRepositories = vi.fn(async () => {
      const current = store.get('environment', 'env');
      store.write({ ...current, expectedRevision: current.revision });
      return ['repo-a'];
    });
    await expect(resolveLaunch(request, services)).rejects.toThrow('after preview');
  });
  it('atomically stores the original snapshot, deduplicates and survives store recreation', async () => {
    const { services, store } = createTestConfiguration(db);
    const request = { repositoryId: 'repo-a', task: 'Fix' };
    const config = await resolveLaunch(request, services);
    const snapshots = createLaunchSnapshotRepository(db, store);
    const createPod = vi.fn(() => insertConfigurationTestPod(db, 'pod-snapshot'));
    const input = {
      config,
      requestId: 'req-1',
      requestDigest: configurationDigest(request),
      createPod,
    };
    expect(snapshots.admit(input)).toEqual({ podId: 'pod-snapshot', created: true });
    const env = store.get('environment', 'env');
    store.write({ ...env, expectedRevision: 1, payload: { ...env.payload, template: 'node24' } });
    expect(snapshots.admit(input).created).toBe(false);
    expect(createPod).toHaveBeenCalledTimes(1);
    expect(() => snapshots.admit({ ...input, requestDigest: 'different' })).toThrow(
      'different payload',
    );
    const reopened = createLaunchSnapshotRepository(db, createConfigurationStore(db));
    expect(reopened.get('pod-snapshot')).toEqual(config);
    const copy = reopened.get('pod-snapshot');
    if (copy) copy.environment.template = 'python312';
    expect(reopened.get('pod-snapshot')?.environment.template).toBe('node22');
    expect(() => snapshots.admit({ ...input, requestId: 'req-2' })).toThrow('after preview');
  });
  it('rolls back pod creation if snapshot insertion fails and detects corruption', async () => {
    const { services, store } = createTestConfiguration(db);
    const config = await resolveLaunch({ repositoryId: 'repo-a', task: 'Fix' }, services);
    const snapshots = createLaunchSnapshotRepository(db, store);
    expect(() =>
      snapshots.admit({
        config,
        requestDigest: 'request',
        createPod: () => {
          insertConfigurationTestPod(db, 'rollback');
          throw new Error('attempt insert failed');
        },
      }),
    ).toThrow('attempt insert failed');
    expect(db.prepare('SELECT 1 FROM pods WHERE id=?').get('rollback')).toBeUndefined();
    snapshots.admit({
      config,
      requestDigest: 'request',
      createPod: () => insertConfigurationTestPod(db, 'corrupt'),
    });
    db.prepare('UPDATE pod_launch_snapshots SET digest=? WHERE pod_id=?').run('bad', 'corrupt');
    expect(() => snapshots.get('corrupt')).toThrow('integrity');
  });
});
