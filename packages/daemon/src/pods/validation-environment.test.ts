import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { EffectiveLaunchConfig, Pod } from '@autopod/shared';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveLaunchCredentialReferences } from '../configuration/credential-references.js';
import { createConfigurationCredentialStore } from '../configuration/credential-store.js';
import {
  type LaunchExecutionCredentials,
  type LaunchRegistryMaterial,
  createLaunchExecutionCredentials,
} from '../configuration/execution-credentials.js';
import { resolveLaunch } from '../configuration/launch-resolver.js';
import { createLaunchSnapshotRepository } from '../configuration/launch-snapshot.js';
import { loadOrCreateKey } from '../crypto/credentials-cipher.js';
import type { PodExecutionSettings } from '../interfaces/pod-execution-settings.js';
import { RUNTIME_TELEMETRY_OPT_OUT_ENV } from '../runtime-env.js';
import { createTestConfiguration } from '../test-utils/configuration-helpers.js';
import {
  createMockContainerManager,
  createMockProfileStore,
  createTestDb,
  insertTestProfile,
} from '../test-utils/mock-helpers.js';
import { createPodRepository } from './pod-repository.js';
import { createProviderAttemptRepository } from './provider-attempt-repository.js';
import { createValidationEnvironment } from './validation-environment.js';

const cleanup: Array<() => void> = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const close of cleanup.splice(0).reverse()) close();
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function fixture() {
  const db = createTestDb();
  cleanup.push(() => db.close());
  insertTestProfile(db);
  const profile: PodExecutionSettings = createMockProfileStore(db).get('test-profile');
  const repo = createPodRepository(db);
  repo.insert({
    id: 'env',
    profileName: 'test-profile',
    task: 'Prepare environment',
    status: 'running',
    runtime: 'claude',
    model: 'claude-sonnet-4-6',
    executionTarget: 'local',
    branch: 'autopod/env',
    userId: 'operator',
    maxValidationAttempts: 3,
    skipValidation: false,
    outputMode: 'pr',
  });
  repo.update('env', { containerId: 'container' });
  const pod = repo.getOrThrow('env');
  const { services } = createTestConfiguration(db);
  const config = await resolveLaunch(
    { repositoryId: 'repo-a', task: 'Prepare environment' },
    services,
  );
  const events: string[] = [];
  const cm = createMockContainerManager();
  const material: LaunchRegistryMaterial = {
    files: [
      { path: '/fixture/npmrc', content: 'npm' },
      { path: '/fixture/nuget.config', content: 'config' },
    ],
    nugetSecret: {
      path: '/fixture/nuget-secret',
      content: 'secret',
      envKey: 'NU',
      envFileKey: 'NU_FILE',
    },
  };
  const build = vi.fn<LaunchExecutionCredentials['buildEnvironment']>(async () => {
    events.push('build');
    return { FIXTURE_BUILD: 'ready', DO_NOT_TRACK: 'custom', NU_FILE: 'wrong' };
  });
  const registries = vi.fn<LaunchExecutionCredentials['registries']>(async () => {
    events.push('registries');
    return material;
  });
  const adapter: LaunchExecutionCredentials = {
    buildEnvironment: build,
    registries,
    agent: async () => ({ buildEnv: {}, mcpServers: [] }),
    deployment: async () => null,
    httpServer: async () => {
      throw new Error('Unused HTTP boundary');
    },
  };
  const service = {
    read: vi.fn((_id: string): EffectiveLaunchConfig | null => {
      events.push('read');
      return config;
    }),
    assertCurrentCapabilities: vi.fn(async (_launch: EffectiveLaunchConfig) => {
      events.push('check');
    }),
  };
  const live: Parameters<typeof createValidationEnvironment>[0] = { launchConfiguration: service };
  const resolver = vi.fn(
    (_launch: EffectiveLaunchConfig): LaunchExecutionCredentials | undefined => {
      events.push('resolve');
      return adapter;
    },
  );
  const get = vi.fn((_target: Pod['executionTarget']) => {
    events.push('get');
    return cm;
  });
  const captured = { executionCredentialsFor: resolver, containerManagerFactory: { get } };
  vi.mocked(cm.writeFile).mockImplementation(async (_id, file) => {
    events.push(file);
  });
  const operations = createValidationEnvironment(live, captured);
  return {
    db,
    profile,
    pod,
    config,
    events,
    cm,
    material,
    adapter,
    build,
    registries,
    service,
    live,
    resolver,
    get,
    captured,
    run: () => operations.validationEnvironmentForPod(pod, profile),
  };
}

describe('validation environment contracts', () => {
  it('constructs without work and preserves exactly the existing callback', async () => {
    const f = await fixture();
    expect(f.events).toEqual([]);
    expect(Object.keys(createValidationEnvironment(f.live, f.captured))).toEqual([
      'validationEnvironmentForPod',
    ]);
    expect(f.events).toEqual([]);
    await f.run();
    expect(f.service.read).toHaveBeenCalledOnce();
    expect(f.service.read).toHaveBeenCalledWith(f.pod.id);
    expect(f.resolver).toHaveBeenCalledWith(f.config);
  });

  it.each([null, undefined, 'fixture-pat'])(
    'legacy PAT=%s preserves env overrides and performs no writes',
    async (pat) => {
      const f = await fixture();
      f.live.launchConfiguration = undefined;
      f.pod.launchConfigDigest = 'missing-launch';
      const profile = {
        ...f.profile,
        registryPat: pat ?? null,
        privateRegistries: [{ type: 'nuget' as const, url: 'https://nuget.example.test' }],
        buildEnv: { DO_NOT_TRACK: 'override', CUSTOM: 'kept' },
      };
      // Exercise an absent runtime field without weakening the production type.
      if (pat === undefined) Object.defineProperty(profile, 'registryPat', { value: undefined });
      const env = await createValidationEnvironment(f.live, f.captured).validationEnvironmentForPod(
        f.pod,
        profile,
      );
      expect(env).toEqual({
        ...RUNTIME_TELEMETRY_OPT_OUT_ENV,
        DO_NOT_TRACK: 'override',
        CUSTOM: 'kept',
        ...(pat ? { VSS_NUGET_EXTERNAL_FEED_ENDPOINTS_FILE: '/run/autopod/nuget-endpoints' } : {}),
      });
      expect(f.events).toEqual([]);
      expect(f.resolver).not.toHaveBeenCalled();
      expect(f.cm.writeFile).not.toHaveBeenCalled();
    },
  );

  it.each([null, undefined, {}])(
    'legacy absent build env=%s retains telemetry defaults',
    async (buildEnv) => {
      const f = await fixture();
      f.service.read.mockReturnValue(null);
      const profile = { ...f.profile, buildEnv: buildEnv ?? null };
      if (buildEnv === undefined) Object.defineProperty(profile, 'buildEnv', { value: undefined });
      const env = await createValidationEnvironment(f.live, f.captured).validationEnvironmentForPod(
        f.pod,
        profile,
      );
      expect(env).toEqual(RUNTIME_TELEMETRY_OPT_OUT_ENV);
      expect(f.events).toEqual([]); // mocked read no longer appends an event
      expect(f.service.read).toHaveBeenCalledOnce();
      expect(f.resolver).not.toHaveBeenCalled();
    },
  );

  it('legacy explicit build env wins over the inferred NuGet pointer', async () => {
    const f = await fixture();
    f.live.launchConfiguration = undefined;
    f.profile.privateRegistries = [{ type: 'nuget', url: 'https://nuget.example.test' }];
    f.profile.registryPat = 'fixture-pat';
    f.profile.buildEnv = { VSS_NUGET_EXTERNAL_FEED_ENDPOINTS_FILE: 'explicit' };
    expect(await f.run()).toMatchObject(f.profile.buildEnv);
    expect(f.cm.writeFile).not.toHaveBeenCalled();
  });

  it('no-adapter fallback checks once and excludes the profile PAT', async () => {
    const f = await fixture();
    f.resolver.mockImplementation(() => {
      f.events.push('resolve');
      return undefined;
    });
    f.profile.registryPat = 'fixture-pat';
    f.profile.privateRegistries = [{ type: 'nuget', url: 'https://nuget.example.test' }];
    f.profile.buildEnv = { CUSTOM: 'kept' };
    expect(await f.run()).toEqual({ ...RUNTIME_TELEMETRY_OPT_OUT_ENV, CUSTOM: 'kept' });
    expect(f.events).toEqual(['read', 'resolve', 'check']);
    expect(f.build).not.toHaveBeenCalled();
    expect(f.cm.writeFile).not.toHaveBeenCalled();
  });

  it.each(['empty', 'npm', 'nuget', 'mixed'] as const)(
    'writes %s material in exact order and applies env precedence',
    async (kind) => {
      const f = await fixture();
      if (kind === 'empty') {
        f.material.files = [];
        f.material.nugetSecret = null;
      }
      if (kind === 'npm') {
        f.material.files = f.material.files.slice(0, 1);
        f.material.nugetSecret = null;
      }
      if (kind === 'nuget') f.material.files = f.material.files.slice(1);
      const files = [
        ...f.material.files,
        ...(f.material.nugetSecret ? [f.material.nugetSecret] : []),
      ];
      expect(await f.run()).toEqual({
        ...RUNTIME_TELEMETRY_OPT_OUT_ENV,
        FIXTURE_BUILD: 'ready',
        DO_NOT_TRACK: 'custom',
        NU_FILE: f.material.nugetSecret?.path ?? 'wrong',
      });
      expect(f.events).toEqual([
        'read',
        'resolve',
        'check',
        'build',
        'registries',
        'get',
        ...files.map((file) => file.path),
        'check',
      ]);
      expect(f.get).toHaveBeenCalledWith('local');
      expect(vi.mocked(f.cm.writeFile).mock.calls).toEqual(
        files.map((file) => ['container', file.path, file.content, { mode: 0o600 }]),
      );
      expect(f.cm.execInContainer).not.toHaveBeenCalled();
      expect(f.build).toHaveBeenCalledWith(f.config);
      expect(f.registries).toHaveBeenCalledWith(f.config);
    },
  );

  it('without a container still resolves both materials, checks twice and returns the pointer', async () => {
    const f = await fixture();
    f.pod.containerId = null;
    expect(await f.run()).toMatchObject({
      FIXTURE_BUILD: 'ready',
      NU_FILE: '/fixture/nuget-secret',
    });
    expect(f.events).toEqual(['read', 'resolve', 'check', 'build', 'registries', 'check']);
    expect(f.get).not.toHaveBeenCalled();
  });

  it.each(['read', 'resolver', 'first check', 'lookup', 'final check'] as const)(
    'preserves exact %s error identity and effect prefix',
    async (where) => {
      const f = await fixture();
      const error = new Error(`Controlled ${where}`);
      if (where === 'read')
        f.service.read.mockImplementation(() => {
          throw error;
        });
      if (where === 'resolver')
        f.resolver.mockImplementation(() => {
          throw error;
        });
      if (where === 'first check') f.service.assertCurrentCapabilities.mockRejectedValueOnce(error);
      if (where === 'lookup')
        f.get.mockImplementation(() => {
          throw error;
        });
      if (where === 'final check')
        f.service.assertCurrentCapabilities
          .mockResolvedValueOnce(undefined)
          .mockRejectedValueOnce(error);
      await expect(f.run()).rejects.toBe(error);
      if (['read', 'resolver', 'first check'].includes(where))
        expect(f.build).not.toHaveBeenCalled();
      expect(f.cm.writeFile).toHaveBeenCalledTimes(where === 'final check' ? 3 : 0);
      expect(f.service.assertCurrentCapabilities).toHaveBeenCalledTimes(
        where === 'read' || where === 'resolver' ? 0 : where === 'final check' ? 2 : 1,
      );
    },
  );

  it.each([1, 2, 3])(
    'stops after write failure %s with exact completed prefix',
    async (failure) => {
      const f = await fixture();
      const error = new Error('Controlled write');
      const files = [
        ...f.material.files,
        ...(f.material.nugetSecret ? [f.material.nugetSecret] : []),
      ];
      const completed: string[] = [];
      vi.mocked(f.cm.writeFile).mockImplementation(async (_id, file) => {
        if (vi.mocked(f.cm.writeFile).mock.calls.length === failure) throw error;
        completed.push(file);
      });
      await expect(f.run()).rejects.toBe(error);
      expect(vi.mocked(f.cm.writeFile).mock.calls.map((call) => call[1])).toEqual(
        files.slice(0, failure).map((file) => file.path),
      );
      expect(completed).toEqual(files.slice(0, failure - 1).map((file) => file.path));
      expect(f.service.assertCurrentCapabilities).toHaveBeenCalledOnce();
    },
  );

  it.each(['build', 'registries'] as const)(
    'starts both material promises before either finishes; waits for %s',
    async (last) => {
      const f = await fixture();
      const build = deferred<Record<string, string>>();
      const registry = deferred<LaunchRegistryMaterial>();
      f.build.mockReturnValue(build.promise);
      f.registries.mockReturnValue(registry.promise);
      let operation: ReturnType<typeof f.run> | undefined;
      try {
        operation = f.run();
        await vi.waitFor(() => expect(f.registries).toHaveBeenCalledOnce());
        expect(f.build.mock.invocationCallOrder[0]).toBeLessThan(
          f.registries.mock.invocationCallOrder[0] ?? 0,
        );
        if (last === 'build') registry.resolve(f.material);
        else build.resolve({ FINISHED: 'yes' });
        await Promise.resolve();
        expect(f.get).not.toHaveBeenCalled();
        build.resolve({ FINISHED: 'yes' });
        registry.resolve(f.material);
        expect(await operation).toMatchObject({ FINISHED: 'yes' });
      } finally {
        build.resolve({ FINISHED: 'yes' });
        registry.resolve(f.material);
        await operation?.catch(() => {});
      }
    },
  );

  it.each(['build', 'registries'] as const)(
    'keeps %s rejection and does not cancel its already started sibling',
    async (failed) => {
      const f = await fixture();
      const error = new Error('Controlled material rejection');
      const build = deferred<Record<string, string>>();
      const registry = deferred<LaunchRegistryMaterial>();
      f.build.mockImplementation(() =>
        failed === 'build' ? Promise.reject(error) : build.promise,
      );
      f.registries.mockImplementation(() =>
        failed === 'registries' ? Promise.reject(error) : registry.promise,
      );
      const operation = f.run();
      try {
        await expect(operation).rejects.toBe(error);
        expect(f.build).toHaveBeenCalledOnce();
        expect(f.registries).toHaveBeenCalledOnce();
        expect(f.get).not.toHaveBeenCalled();
        expect(f.cm.writeFile).not.toHaveBeenCalled();
        expect(f.service.assertCurrentCapabilities).toHaveBeenCalledOnce();
      } finally {
        build.resolve({});
        registry.resolve(f.material);
        await Promise.all([build.promise, registry.promise, operation.catch(() => {})]);
      }
    },
  );

  it.each(['build', 'registries'] as const)(
    'retains synchronous %s throw evaluation order',
    async (failed) => {
      const f = await fixture();
      const error = new Error('Controlled synchronous material throw');
      const sibling = deferred<Record<string, string>>();
      if (failed === 'build')
        f.build.mockImplementation(() => {
          throw error;
        });
      else {
        f.build.mockReturnValue(sibling.promise);
        f.registries.mockImplementation(() => {
          throw error;
        });
      }
      const operation = f.run();
      try {
        await expect(operation).rejects.toBe(error);
        expect(f.build).toHaveBeenCalledOnce();
        expect(f.registries).toHaveBeenCalledTimes(failed === 'build' ? 0 : 1);
        expect(f.get).not.toHaveBeenCalled();
      } finally {
        sibling.resolve({});
        await sibling.promise;
        await operation.catch(() => {});
      }
    },
  );

  it('uses the original selected adapter and its late methods after a held first check', async () => {
    const f = await fixture();
    const hold = deferred<void>();
    f.service.assertCurrentCapabilities.mockImplementationOnce(() => hold.promise);
    const replacementBuild = vi.fn(async function (
      this: LaunchExecutionCredentials,
      launch: EffectiveLaunchConfig,
    ) {
      expect(this).toBe(f.adapter);
      expect(launch).toBe(f.config);
      return { LATE: 'yes' };
    });
    const replacementRegistries = vi.fn(async function (this: LaunchExecutionCredentials) {
      expect(this).toBe(f.adapter);
      return { files: [], nugetSecret: null };
    });
    let operation: ReturnType<typeof f.run> | undefined;
    try {
      operation = f.run();
      await vi.waitFor(() => expect(f.resolver).toHaveBeenCalledOnce());
      f.resolver.mockReturnValue(undefined);
      f.adapter.buildEnvironment = replacementBuild;
      f.adapter.registries = replacementRegistries;
      hold.resolve();
      expect(await operation).toMatchObject({ LATE: 'yes' });
      expect(f.build).not.toHaveBeenCalled();
      expect(f.registries).not.toHaveBeenCalled();
      expect(replacementBuild).toHaveBeenCalledOnce();
      expect(replacementRegistries).toHaveBeenCalledOnce();
    } finally {
      hold.resolve();
      await operation?.catch(() => {});
    }
  });

  it.each(['first check', 'material', 'write'] as const)(
    'observes live service replacement/removal across %s',
    async (stage) => {
      for (const remove of [false, true]) {
        const f = await fixture();
        const hold = deferred<void>();
        const entered = deferred<void>();
        const pause = async () => {
          entered.resolve();
          await hold.promise;
        };
        if (stage === 'first check')
          f.service.assertCurrentCapabilities.mockImplementationOnce(pause);
        if (stage === 'material')
          f.build.mockImplementationOnce(async () => {
            await pause();
            return { HELD: 'yes' };
          });
        if (stage === 'write') vi.mocked(f.cm.writeFile).mockImplementationOnce(pause);
        const next = {
          read: vi.fn(() => {
            throw new Error('Must not reread launch');
          }),
          assertCurrentCapabilities: vi.fn(async function (
            this: unknown,
            launch: EffectiveLaunchConfig,
          ) {
            expect(this).toBe(next);
            expect(launch).toBe(f.config);
          }),
        };
        let operation: ReturnType<typeof f.run> | undefined;
        try {
          operation = f.run();
          await entered.promise;
          f.live.launchConfiguration = remove ? undefined : next;
          hold.resolve();
          await operation;
          expect(f.service.read).toHaveBeenCalledOnce();
          expect(f.service.assertCurrentCapabilities).toHaveBeenCalledOnce();
          expect(next.read).not.toHaveBeenCalled();
          expect(next.assertCurrentCapabilities).toHaveBeenCalledTimes(remove ? 0 : 1);
        } finally {
          hold.resolve();
          await operation?.catch(() => {});
        }
      }
    },
  );

  it('uses current pod fields and late methods on the captured factory across material awaits', async () => {
    const f = await fixture();
    const hold = deferred<Record<string, string>>();
    f.build.mockReturnValue(hold.promise);
    const replacement = vi.fn(function (this: unknown, target: Pod['executionTarget']) {
      expect(this).toBe(f.captured.containerManagerFactory);
      expect(target).toBe('sandbox');
      return f.cm;
    });
    let operation: ReturnType<typeof f.run> | undefined;
    try {
      operation = f.run();
      await vi.waitFor(() => expect(f.registries).toHaveBeenCalledOnce());
      f.pod.containerId = 'late-container';
      f.pod.executionTarget = 'sandbox';
      f.captured.containerManagerFactory.get = replacement;
      hold.resolve({});
      await operation;
      expect(f.get).not.toHaveBeenCalled();
      expect(replacement).toHaveBeenCalledOnce();
      expect(
        vi.mocked(f.cm.writeFile).mock.calls.every((call) => call[0] === 'late-container'),
      ).toBe(true);
    } finally {
      hold.resolve({});
      await operation?.catch(() => {});
    }
  });

  it('retains late pod container reads between sequential writes', async () => {
    const f = await fixture();
    vi.mocked(f.cm.writeFile).mockImplementationOnce(async () => {
      f.pod.containerId = 'changed-container';
    });
    await f.run();
    expect(vi.mocked(f.cm.writeFile).mock.calls.map((call) => call[0])).toEqual([
      'container',
      'changed-container',
      'changed-container',
    ]);
  });
});

async function durableFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'validation-environment-'));
  const file = path.join(root, 'state.db');
  const seed = createTestDb();
  try {
    insertTestProfile(seed);
    fs.writeFileSync(file, seed.serialize());
  } finally {
    seed.close();
  }
  let db = new Database(file);
  db.pragma('foreign_keys = ON');
  cleanup.push(() => {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const credentials = createConfigurationCredentialStore(
    db,
    loadOrCreateKey(path.join(root, 'fixture.key')),
    async () => {},
  );
  for (const [id, purposes, origins] of [
    ['build', ['build-env'], []],
    ['npm', ['registry-read'], ['https://npm.example.test']],
    ['nuget', ['registry-read'], ['https://nuget.example.test']],
    ['other', ['build-env'], []],
  ] as const)
    await credentials.create({
      id,
      name: id,
      purposes: [...purposes],
      origins: [...origins],
      value: `private-${id}-fixture`,
    });
  const { store, services } = createTestConfiguration(db);
  services.resolveCredentialReferences = async (config) =>
    resolveLaunchCredentialReferences(config, credentials);
  const repository = store.get('repository', 'repo-a');
  store.write({
    ...repository,
    expectedRevision: repository.revision,
    payload: {
      ...repository.payload,
      setups: repository.payload.setups.map((setup) => ({
        ...setup,
        buildEnv: { SERVICE_TOKEN: { secretId: 'build' } },
        integrations: {
          ...setup.integrations,
          privateRegistries: [
            {
              type: 'npm',
              url: 'https://npm.example.test/feed/',
              scope: '@fixture',
              credential: { secretId: 'npm' },
            },
            {
              type: 'nuget',
              url: 'https://nuget.example.test/feed/',
              credential: { secretId: 'nuget' },
            },
          ],
        },
      })),
    },
  });
  const config = await resolveLaunch(
    { repositoryId: 'repo-a', task: 'Prepare durable environment' },
    services,
  );
  const snapshots = createLaunchSnapshotRepository(db, store);
  const repo = createPodRepository(db);
  snapshots.admit({
    config,
    requestDigest: 'fixture-request',
    createPod: () => {
      repo.insert({
        id: 'durable',
        profileName: 'test-profile',
        task: config.task,
        status: 'running',
        runtime: 'claude',
        model: 'claude-sonnet-4-6',
        executionTarget: 'local',
        branch: 'autopod/durable',
        userId: 'operator',
        maxValidationAttempts: 3,
        skipValidation: false,
        outputMode: 'pr',
      });
      return 'durable';
    },
  });
  const attemptSnapshot = { modelProvider: 'anthropic' };
  const attemptHash = createHash('sha256')
    .update(JSON.stringify(attemptSnapshot))
    .digest('hex')
    .slice(0, 16);
  createProviderAttemptRepository(db).open({
    podId: 'durable',
    provider: 'anthropic',
    providerAccountId: null,
    runtime: 'claude',
    model: 'claude-sonnet-4-6',
    profileReference: `pod:durable@profile-snapshot#${attemptHash}`,
    profileSnapshot: attemptSnapshot,
  });
  repo.update('durable', { containerId: 'durable-container' });
  const pod = repo.getOrThrow('durable');
  const profile = createMockProfileStore(db).get('test-profile');
  const cm = createMockContainerManager();
  const adapter = createLaunchExecutionCredentials(credentials);
  const check = vi.fn(async () => {});
  const service = { read: snapshots.get, assertCurrentCapabilities: check };
  const op = createValidationEnvironment(
    { launchConfiguration: service },
    { executionCredentialsFor: () => adapter, containerManagerFactory: { get: () => cm } },
  );
  const rows = () => ({
    credentials: db.prepare('SELECT * FROM configuration_credentials ORDER BY id').all(),
    profiles: db.prepare('SELECT * FROM profiles ORDER BY name').all(),
    pods: db.prepare('SELECT * FROM pods ORDER BY id').all(),
    attempts: db.prepare('SELECT * FROM provider_attempts ORDER BY pod_id,ordinal').all(),
    snapshots: db.prepare('SELECT * FROM pod_launch_snapshots ORDER BY pod_id').all(),
  });
  return {
    db,
    credentials,
    config,
    snapshots,
    repo,
    pod,
    profile,
    cm,
    check,
    rows,
    run: () => op.validationEnvironmentForPod(pod, profile),
    reopen() {
      db.close();
      db = new Database(file);
      db.pragma('foreign_keys = ON');
      expect(db.pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }]);
      expect(db.pragma('foreign_key_check')).toEqual([]);
      return { snapshots: createLaunchSnapshotRepository(db, store), rows: rows() };
    },
  };
}

describe('validation environment with real persisted credentials', () => {
  it('resolves current independent tokens, rotates without snapshot changes and preserves other durable rows', async () => {
    const f = await durableFixture();
    const initial = f.rows();
    expect(initial.attempts).toHaveLength(1);
    const snapshot = JSON.stringify(f.snapshots.get(f.pod.id));
    expect(await f.run()).toMatchObject({
      SERVICE_TOKEN: 'private-build-fixture',
      VSS_NUGET_EXTERNAL_FEED_ENDPOINTS_FILE: '/run/autopod/nuget-endpoints',
    });
    expect(f.rows()).toEqual(initial);
    await f.credentials.rotate('build', 1, 'rotated-build-fixture');
    await f.credentials.rotate('npm', 1, 'rotated-npm-fixture');
    await f.credentials.rotate('nuget', 1, 'rotated-nuget-fixture');
    const rotated = f.rows();
    vi.mocked(f.cm.writeFile).mockClear();
    expect(await f.run()).toMatchObject({ SERVICE_TOKEN: 'rotated-build-fixture' });
    const writes = vi.mocked(f.cm.writeFile).mock.calls;
    expect(writes).toHaveLength(3);
    expect(writes.map((call) => call[3])).toEqual([
      { mode: 0o600 },
      { mode: 0o600 },
      { mode: 0o600 },
    ]);
    expect(writes[0]?.[2]).toContain('rotated-npm-fixture');
    expect(writes[0]?.[2]).not.toContain('rotated-nuget-fixture');
    expect(writes[1]?.[2]).not.toContain('private-');
    expect(writes[1]?.[2]).not.toContain('rotated-');
    expect(writes[2]?.[2]).toContain('rotated-nuget-fixture');
    expect(writes[2]?.[2]).not.toContain('rotated-npm-fixture');
    expect(f.rows()).toEqual(rotated);
    expect(JSON.stringify(f.snapshots.get(f.pod.id))).toBe(snapshot);
    expect(snapshot).not.toContain('private-');
    expect(rotated.profiles).toEqual(initial.profiles);
    expect(rotated.pods).toEqual(initial.pods);
    expect(rotated.attempts).toEqual(initial.attempts);
    const other = (rows: typeof initial) =>
      rows.credentials.filter((row) => (row as { id: string }).id === 'other');
    expect(other(rotated)).toEqual(other(initial));
    const reopened = f.reopen();
    expect(reopened.rows).toEqual(rotated);
    expect(JSON.stringify(reopened.snapshots.get(f.pod.id))).toBe(snapshot);
  });

  it.each(['build', 'npm', 'nuget'] as const)(
    'rejects revoked %s without writing and leaves saved state untouched',
    async (id) => {
      const f = await durableFixture();
      f.credentials.revoke(id, 1);
      const before = f.rows();
      await expect(f.run()).rejects.toMatchObject({ code: 'CONFIG_CREDENTIAL_REVOKED' });
      expect(f.cm.writeFile).not.toHaveBeenCalled();
      expect(f.check).toHaveBeenCalledOnce();
      // Each sibling is local and has no mutation; yield so its resolution finishes before close.
      await new Promise<void>((done) => setImmediate(done));
      expect(f.rows()).toEqual(before);
      expect(f.reopen().rows).toEqual(before);
    },
  );

  it.each(['purpose', 'origin', 'identity'] as const)(
    'rejects changed credential %s under saved launch scope',
    async (kind) => {
      const f = await durableFixture();
      if (kind === 'purpose')
        f.db
          .prepare('UPDATE configuration_credentials SET purposes=? WHERE id=?')
          .run(JSON.stringify(['mcp-env']), 'npm');
      if (kind === 'origin')
        f.db
          .prepare('UPDATE configuration_credentials SET origins=? WHERE id=?')
          .run(JSON.stringify(['https://other.example.test']), 'npm');
      if (kind === 'identity')
        f.db
          .prepare('UPDATE configuration_credentials SET created_at=? WHERE id=?')
          .run('2000-01-01T00:00:00Z', 'npm');
      const before = f.rows();
      await expect(f.run()).rejects.toMatchObject({
        code: kind === 'identity' ? 'CONFIG_CREDENTIAL_REVOKED' : 'CONFIG_CREDENTIAL_SCOPE',
      });
      await new Promise<void>((done) => setImmediate(done));
      expect(f.cm.writeFile).not.toHaveBeenCalled();
      expect(f.rows()).toEqual(before);
      expect(f.reopen().rows).toEqual(before);
    },
  );

  it('retains actual credential rows and completed writes when the final capability check rejects', async () => {
    const f = await durableFixture();
    const before = f.rows();
    const error = new Error('Late persisted-material check');
    f.check.mockResolvedValueOnce(undefined).mockRejectedValueOnce(error);
    await expect(f.run()).rejects.toBe(error);
    expect(f.cm.writeFile).toHaveBeenCalledTimes(3);
    expect(f.rows()).toEqual(before);
    expect(f.reopen().rows).toEqual(before);
  });
});
