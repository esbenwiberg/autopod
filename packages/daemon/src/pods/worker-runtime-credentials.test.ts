import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  type EffectiveLaunchConfig,
  PROVIDER_CATALOG,
  type Pod,
  type ProviderCredentials,
} from '@autopod/shared';
import Database from 'better-sqlite3';
import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveLaunchAgentRoute } from '../configuration/agent-route-resolution.js';
import { resolveLaunch } from '../configuration/launch-resolver.js';
import type { PodExecutionSettings } from '../interfaces/pod-execution-settings.js';
import { createProviderAccountStore } from '../provider-accounts/provider-account-store.js';
import * as azureTokens from '../providers/azure-token.js';
import * as providers from '../providers/index.js';
import type { MaxCredentialLineage, ProviderEnvResult } from '../providers/index.js';
import { createTestConfiguration } from '../test-utils/configuration-helpers.js';
import {
  createMockContainerManager,
  createMockProfileStore,
  createTestDb,
  insertTestProfile,
} from '../test-utils/mock-helpers.js';
import { createPodRepository } from './pod-repository.js';
import { createProviderAttemptRepository } from './provider-attempt-repository.js';
import { createWorkerRuntimeCredentials } from './worker-runtime-credentials.js';

const cleanup: Array<() => void> = [];
beforeEach(() => {
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(
    new Error('External network forbidden in worker credential fixture'),
  );
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.useRealTimers();
  for (const close of cleanup.splice(0).reverse()) close();
});
function needed<T>(value: T | null | undefined): T {
  if (value == null) throw new Error('Missing worker fixture');
  return value;
}
function gate() {
  let release = () => {};
  const promise = new Promise<void>((done) => {
    release = done;
  });
  return { promise, release };
}
type Provider = 'anthropic' | 'openai' | 'pi' | 'max' | 'foundry';
function credentials(provider: Provider): ProviderCredentials {
  switch (provider) {
    case 'anthropic':
      return { provider, apiKey: 'fixture-api-key' };
    case 'openai':
      return { provider, authMode: 'chatgpt', authJson: '{"token":"fixture-old"}' };
    case 'pi':
      return { provider, providerId: 'anthropic', credential: { access: 'fixture-old' } };
    case 'max':
      return { provider, authMode: 'setup-token', oauthToken: 'fixture-setup-token' };
    case 'foundry':
      return {
        provider,
        endpoint: 'https://fixture.services.ai.azure.com',
        apiKey: 'fixture-foundry',
      };
  }
}
function fixture(provider: Provider = 'openai') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'worker-runtime-credentials-'));
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
  const accounts = createProviderAccountStore(db);
  const initial = credentials(provider);
  accounts.create({ id: 'selected', name: 'Selected', provider, credentials: initial });
  accounts.create({
    id: 'other',
    name: 'Other',
    provider: 'anthropic',
    credentials: { provider: 'anthropic', apiKey: 'untouched-fixture' },
  });
  const other = accounts.get('other');
  const profileStore = createMockProfileStore(db);
  const runtime = provider === 'openai' ? 'codex' : provider === 'pi' ? 'pi' : 'claude';
  const profile: PodExecutionSettings = {
    ...profileStore.get('test-profile'),
    providerAccountId: 'selected',
    providerCredentials: initial,
    modelProvider: provider,
    defaultRuntime: runtime,
    defaultModel: 'main-model',
    reviewerModel: 'review-model',
    reasoningEffort: 'high',
  };
  const repo = createPodRepository(db);
  repo.insert({
    id: 'worker',
    profileName: 'test-profile',
    task: 'Review',
    status: 'validating',
    runtime,
    model: 'main-model',
    providerAccountIdSnapshot: 'selected',
    providerIdSnapshot: provider,
    executionTarget: 'local',
    branch: 'feature/context',
    userId: 'operator',
    maxValidationAttempts: 3,
    skipValidation: false,
    outputMode: 'pr',
  });
  repo.update('worker', { containerId: 'container' });
  const pod = repo.getOrThrow('worker');
  const attempts = createProviderAttemptRepository(db);
  const cm = createMockContainerManager();
  const get = vi.fn((_target: Pod['executionTarget']) => cm);
  const bound = vi.fn((_pod: Pod): PodExecutionSettings => profile);
  const logger = pino({ level: 'silent' });
  const warn = vi.spyOn(logger, 'warn');
  const lineage = new Map<string, MaxCredentialLineage>();
  const readPod = vi.spyOn(repo, 'getOrThrow');
  const validation = vi.fn(
    async (
      _pod: Pod,
      _profile: PodExecutionSettings,
    ): Promise<Record<string, string> | undefined> => ({
      BUILD_ONLY: 'build',
      SHARED: 'build',
      POD_ID: 'build-id',
    }),
  );
  const remember = vi.fn((id: string, result: ProviderEnvResult) => {
    if (result.maxCredentialLineage) lineage.set(id, result.maxCredentialLineage);
    else lineage.delete(id);
  });
  const live: Parameters<typeof createWorkerRuntimeCredentials>[0] = {};
  const captured: Parameters<typeof createWorkerRuntimeCredentials>[1] = {
    providerAccountStore: accounts,
    providerCatalog: PROVIDER_CATALOG,
    profileStore,
    containerManagerFactory: { get },
    logger,
    maxCredentialLineageByPod: lineage,
    podRepo: repo,
    validationEnvironmentForPod: validation,
    rememberMaxCredentialLineage: remember,
    resolveEffectiveBoundProfile: bound,
  };
  const op = createWorkerRuntimeCredentials(live, captured);
  const build = vi.spyOn(providers, 'buildProviderEnv');
  const max = vi.spyOn(providers, 'persistRefreshedCredentials');
  const openai = vi.spyOn(providers, 'persistOpenAiAuthJson');
  const pi = vi.spyOn(providers, 'persistPiAuthJson');
  const savedProfile = db.prepare('SELECT * FROM profiles WHERE name=?').get('test-profile');
  const reopen = () => {
    db.close();
    db = new Database(file);
    db.pragma('foreign_keys = ON');
    expect(db.pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }]);
    expect(db.pragma('foreign_key_check')).toEqual([]);
    expect(createProviderAccountStore(db).get('other')).toEqual(other);
    expect(db.prepare('SELECT * FROM profiles WHERE name=?').get('test-profile')).toEqual(
      savedProfile,
    );
    return {
      accounts: createProviderAccountStore(db),
      attempts: createProviderAttemptRepository(db).listRaw('worker'),
    };
  };
  const openAttempt = (closed = false) => {
    const snapshot = { modelProvider: provider };
    const hash = createHash('sha256').update(JSON.stringify(snapshot)).digest('hex').slice(0, 16);
    const row = attempts.open({
      podId: pod.id,
      provider,
      providerAccountId: 'selected',
      runtime,
      model: pod.model,
      profileReference: `pod:${pod.id}@profile-snapshot#${hash}`,
      profileSnapshot: snapshot,
    });
    if (closed)
      attempts.close(pod.id, {
        nativeSessionId: null,
        outcome: 'completed',
        inputTokens: 0,
        outputTokens: 0,
        costUsd: 0,
      });
    return row;
  };
  return {
    root,
    file,
    db: () => db,
    accounts,
    other,
    profileStore,
    profile,
    repo,
    pod,
    attempts,
    cm,
    get,
    readPod,
    validation,
    remember,
    bound,
    logger,
    warn,
    lineage,
    live,
    captured,
    op,
    build,
    max,
    openai,
    pi,
    initial,
    reopen,
    openAttempt,
  };
}
async function launch(f: ReturnType<typeof fixture>) {
  const { services } = createTestConfiguration(f.db());
  f.accounts.create({
    id: 'account',
    name: 'Launch main',
    provider: 'anthropic',
    credentials: { provider: 'anthropic', apiKey: 'fixture-launch' },
  });
  services.resolveAgentRoute = async (route) => resolveLaunchAgentRoute(route, f.accounts);
  const config = await resolveLaunch(
    { repositoryId: 'repo-a', task: 'Worker credentials' },
    services,
  );
  const check = vi.fn(async (_config: EffectiveLaunchConfig) => {});
  const read = vi.fn((_id: string) => config);
  const service = { read, assertCurrentCapabilities: check };
  f.live.launchConfiguration = service;
  return { config, check, read, service };
}
function controlledBuild(f: ReturnType<typeof fixture>, withLineage = false) {
  const result: ProviderEnvResult = {
    env: { SHARED: 'provider', PROVIDER_ONLY: 'provider', POD_ID: 'provider-id' },
    containerFiles: [
      { path: '/fixture/a', content: 'a' },
      { path: '/fixture/b', content: 'b' },
    ],
    secretFiles: [
      { path: '/fixture/secret-a', content: 'sa' },
      { path: '/fixture/secret-b', content: 'sb' },
    ],
    requiresPostExecPersistence: false,
    ...(withLineage
      ? {
          maxCredentialLineage: {
            owner: { type: 'provider-account' as const, id: 'selected' },
            issuedRefreshToken: 'issued-fixture',
          },
        }
      : {}),
  };
  f.build.mockResolvedValue(result);
  return result;
}

describe('worker resume environment', () => {
  it('constructs without reads, binding, env, readback, map updates or target work', () => {
    const f = fixture();
    expect(f.readPod).not.toHaveBeenCalled();
    expect(f.bound).not.toHaveBeenCalled();
    expect(f.get).not.toHaveBeenCalled();
    expect(f.validation).not.toHaveBeenCalled();
    expect(f.remember).not.toHaveBeenCalled();
    expect(f.build).not.toHaveBeenCalled();
    expect(f.max).not.toHaveBeenCalled();
    expect(f.openai).not.toHaveBeenCalled();
    expect(f.pi).not.toHaveBeenCalled();
    f.reopen();
  });
  it('awaits bound profile then live launch and validation env before any recovery/build', async () => {
    const f = fixture();
    const l = await launch(f);
    const entered = gate();
    const held = gate();
    const steps: string[] = [];
    f.bound.mockImplementation(() => {
      steps.push('profile');
      return f.profile;
    });
    l.read.mockImplementation(() => {
      steps.push('launch');
      return l.config;
    });
    f.validation.mockImplementation(async (p, profile) => {
      expect(p).toBe(f.pod);
      expect(profile).toBe(f.profile);
      steps.push('validation');
      entered.release();
      await held.promise;
      return { BUILD_ONLY: 'build' };
    });
    controlledBuild(f);
    const pending = f.op.getResumeEnv(f.pod);
    try {
      await entered.promise;
      expect(steps).toEqual(['profile', 'launch', 'validation']);
      expect(f.openai).not.toHaveBeenCalled();
      expect(f.build).not.toHaveBeenCalled();
    } finally {
      held.release();
      await pending;
    }
    expect(f.bound).toHaveBeenCalledOnce();
    expect(l.check).toHaveBeenCalledExactlyOnceWith(l.config);
    f.reopen();
  });
  it.each(['anthropic', 'copilot', 'openrouter', null] as const)(
    'legacy provider=%s skips provider env/readback before any map effects',
    async (provider) => {
      const f = fixture();
      f.profile.modelProvider = provider;
      await expect(f.op.getResumeEnv(f.pod)).resolves.toBeUndefined();
      expect(f.build).not.toHaveBeenCalled();
      expect(f.get).not.toHaveBeenCalled();
      expect(f.remember).not.toHaveBeenCalled();
      f.reopen();
    },
  );
  it.each(['missing', 'mismatch', 'static'] as const)(
    'legacy Foundry %s credentials skip before builder',
    async (kind) => {
      const f = fixture('foundry');
      f.profile.providerCredentials =
        kind === 'missing'
          ? null
          : kind === 'mismatch'
            ? { provider: 'anthropic', apiKey: 'fixture' }
            : f.initial;
      await expect(f.op.getResumeEnv(f.pod)).resolves.toBeUndefined();
      expect(f.build).not.toHaveBeenCalled();
      expect(f.remember).not.toHaveBeenCalled();
      f.reopen();
    },
  );
  it.each(
    (['max', 'openai', 'pi'] as const).flatMap((provider) =>
      [false, true].flatMap((composed) =>
        [false, true].map((container) => ({ provider, composed, container })),
      ),
    ),
  )(
    'actual $provider launch=$composed container=$container keeps local auth and modes',
    async ({ provider, composed, container }) => {
      const f = fixture(provider);
      const l = composed ? await launch(f) : null;
      if (!container) f.pod.containerId = null;
      const env = await f.op.getResumeEnv(f.pod);
      expect(env).toMatchObject({ POD_ID: 'worker' });
      expect(f.bound).toHaveBeenCalledOnce();
      expect(f.build).toHaveBeenCalledOnce();
      expect(f.remember).toHaveBeenCalledOnce();
      expect(f.validation).toHaveBeenCalledTimes(composed ? 1 : 0);
      expect(f.max).toHaveBeenCalledTimes(provider === 'max' && container ? 1 : 0);
      expect(f.openai).toHaveBeenCalledTimes(provider === 'openai' && container ? 1 : 0);
      expect(f.pi).toHaveBeenCalledTimes(provider === 'pi' && container ? 1 : 0);
      if (container) {
        const call = needed(vi.mocked(f.cm.writeFile).mock.calls[0]);
        expect(call[3]).toEqual(composed ? { mode: 0o600 } : undefined);
        if (provider === 'max') {
          const secret = needed(
            vi.mocked(f.cm.writeFile).mock.calls.find((c) => c[2] === 'fixture-setup-token'),
          );
          if (composed) {
            expect(secret[3]).toEqual({ mode: 0o400 });
            expect(f.cm.execInContainer).not.toHaveBeenCalled();
          } else {
            expect(secret).toHaveLength(3);
            expect(f.cm.execInContainer).toHaveBeenCalledWith(
              'container',
              ['chmod', '0400', secret[1]],
              { timeout: 5_000 },
            );
          }
        }
      } else expect(f.cm.writeFile).not.toHaveBeenCalled();
      if (l) expect(l.check).toHaveBeenCalledExactlyOnceWith(l.config);
      expect(globalThis.fetch).not.toHaveBeenCalled();
      f.reopen();
    },
  );
  it.each(['anthropic', 'foundry'] as const)(
    'launch bypasses legacy %s skip and writes actual auth with explicit modes',
    async (provider) => {
      const f = fixture(provider);
      const l = await launch(f);
      await expect(f.op.getResumeEnv(f.pod)).resolves.toMatchObject({
        POD_ID: 'worker',
        BUILD_ONLY: 'build',
      });
      expect(f.cm.writeFile).toHaveBeenCalledWith(
        'container',
        expect.any(String),
        provider === 'anthropic' ? 'fixture-api-key' : 'fixture-foundry',
        { mode: 0o400 },
      );
      expect(f.cm.execInContainer).not.toHaveBeenCalled();
      expect(l.check).toHaveBeenCalledOnce();
      expect(globalThis.fetch).not.toHaveBeenCalled();
      f.reopen();
    },
  );
  it.each(['success', 'failure'] as const)(
    'Foundry token boundary %s propagates current result without readback',
    async (outcome) => {
      const f = fixture('foundry');
      const creds: ProviderCredentials = {
        provider: 'foundry',
        endpoint: 'https://fixture.services.ai.azure.com',
      };
      f.profile.providerCredentials = creds;
      f.accounts.updateCredentials('selected', creds);
      const error = new Error('Controlled Foundry token');
      const token = vi.spyOn(azureTokens, 'getAzureToken');
      if (outcome === 'failure') token.mockRejectedValue(error);
      else
        token.mockResolvedValue({ token: 'fixture-bearer', expiresAtMs: Date.now() + 3_600_000 });
      const pending = f.op.getResumeEnv(f.pod);
      if (outcome === 'failure') {
        await expect(pending).rejects.toBe(error);
        expect(f.remember).not.toHaveBeenCalled();
      } else {
        await expect(pending).resolves.toMatchObject({
          ANTHROPIC_FOUNDRY_AUTH_TOKEN_FILE: expect.any(String),
        });
        expect(f.cm.writeFile).toHaveBeenCalledWith(
          'container',
          expect.any(String),
          'fixture-bearer',
        );
      }
      expect(f.cm.readFile).not.toHaveBeenCalled();
      expect(token).toHaveBeenCalledOnce();
      f.reopen();
    },
  );
  it.each(['openai', 'pi'] as const)(
    'actual %s rotation survives a later auth write failure and SQLite reopen',
    async (provider) => {
      const f = fixture(provider);
      f.openAttempt();
      const rows = f.attempts.listRaw('worker');
      const fresh =
        provider === 'openai' ? '{"token":"worker-new"}' : '{"anthropic":{"access":"worker-new"}}';
      vi.mocked(f.cm.readFile).mockResolvedValue(fresh);
      const error = new Error('After durable rotation');
      vi.mocked(f.cm.writeFile).mockImplementation(async (_id, file) => {
        if (file.endsWith('/auth.json')) throw error;
      });
      await expect(f.op.getResumeEnv(f.pod)).rejects.toBe(error);
      expect(f.bound).toHaveBeenCalledOnce();
      expect(f.remember).toHaveBeenCalledOnce();
      const reopened = f.reopen();
      expect(reopened.attempts).toEqual(rows);
      expect(reopened.accounts.get('selected').credentials).toMatchObject(
        provider === 'openai'
          ? { provider, authJson: fresh }
          : { provider, credential: { access: 'worker-new' } },
      );
    },
  );
  it('nonexpired MAX uses original map lineage and remembers the actual issued result before writes', async () => {
    const f = fixture('max');
    const creds: ProviderCredentials = {
      provider: 'max',
      accessToken: 'fixture-access',
      refreshToken: 'fixture-refresh',
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    };
    f.accounts.updateCredentials('selected', creds);
    f.profile.providerCredentials = creds;
    const old: MaxCredentialLineage = {
      owner: { type: 'provider-account', id: 'selected' },
      issuedRefreshToken: 'fixture-refresh',
    };
    f.lineage.set('worker', old);
    const get = vi.spyOn(f.lineage, 'get');
    vi.mocked(f.cm.writeFile).mockImplementation(async () => {
      expect(f.lineage.get('worker')).toEqual(old);
      expect(f.remember).toHaveBeenCalledOnce();
    });
    await f.op.getResumeEnv(f.pod);
    expect(f.max.mock.calls[0]?.[5]).toBe(old);
    expect(get).toHaveBeenCalledWith('worker');
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(f.reopen().accounts.get('selected').credentials).toEqual(creds);
  });
  it('controlled expiring MAX refresh persists through the actual refresh/persistence helper without external OAuth', async () => {
    const f = fixture('max');
    const old = {
      provider: 'max' as const,
      accessToken: 'old',
      refreshToken: 'old-refresh',
      expiresAt: new Date(Date.now() - 1).toISOString(),
    };
    f.accounts.updateCredentials('selected', old);
    f.profile.providerCredentials = old;
    const refresh = await import('../providers/credential-refresh.js');
    const fresh = {
      ...old,
      accessToken: 'new',
      refreshToken: 'new-refresh',
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    };
    const issue = vi.spyOn(refresh, 'refreshOAuthToken').mockResolvedValue(fresh);
    await f.op.getResumeEnv(f.pod);
    expect(issue).toHaveBeenCalled();
    expect(f.lineage.get('worker')).toEqual({
      owner: { type: 'provider-account', id: 'selected' },
      issuedRefreshToken: 'new-refresh',
    });
    expect(f.reopen().accounts.get('selected').credentials).toEqual(fresh);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
  it.each(
    (['max', 'openai', 'pi'] as const).flatMap((provider) =>
      (['target', 'helper'] as const).map((stage) => ({ provider, stage })),
    ),
  )(
    '$provider recovery catches $stage with the original warning then continues',
    async ({ provider, stage }) => {
      const f = fixture(provider);
      controlledBuild(f);
      const error = new Error('Controlled recovery');
      if (stage === 'target')
        f.get.mockImplementationOnce(() => {
          throw error;
        });
      else
        (provider === 'max' ? f.max : provider === 'openai' ? f.openai : f.pi).mockRejectedValue(
          error,
        );
      await f.op.getResumeEnv(f.pod);
      const message =
        provider === 'max'
          ? 'Could not recover credentials from container before resume — will try profile store'
          : provider === 'openai'
            ? 'Could not recover Codex auth.json from container before resume'
            : 'Could not recover Pi auth.json from container before resume';
      expect(f.warn).toHaveBeenCalledExactlyOnceWith({ err: error, podId: 'worker' }, message);
      expect(f.build).toHaveBeenCalledOnce();
      expect(f.bound).toHaveBeenCalledOnce();
      f.reopen();
    },
  );
  it.each(['absent', 'different'] as const)(
    'resume keeps profile-derived owner=%s rather than pod binding',
    async (owner) => {
      const f = fixture();
      f.profile.providerAccountId = owner === 'absent' ? null : 'other';
      controlledBuild(f);
      f.openai.mockResolvedValue();
      await f.op.getResumeEnv(f.pod);
      expect(f.openai.mock.calls[0]?.at(-1)).toEqual({
        providerAccountStore: f.accounts,
        owner: owner === 'absent' ? undefined : { type: 'provider-account', id: 'other' },
      });
      expect(f.build.mock.calls[0]?.[3]?.providerBinding).toEqual({
        accountId: 'selected',
        providerId: 'openai',
      });
      f.reopen();
    },
  );
  it('holds recovery without re-reading the bound profile and observes newly persisted account auth', async () => {
    const f = fixture();
    const entered = gate();
    const held = gate();
    const original = f.profile;
    f.openai.mockImplementation(async () => {
      entered.release();
      await held.promise;
      f.accounts.updateCredentials('selected', {
        provider: 'openai',
        authJson: '{"token":"held-worker"}',
      });
      f.bound.mockReturnValue({ ...original, defaultModel: 'replacement' });
    });
    const pending = f.op.getResumeEnv(f.pod);
    try {
      await entered.promise;
      expect(f.build).not.toHaveBeenCalled();
    } finally {
      held.release();
      await pending;
    }
    expect(f.bound).toHaveBeenCalledOnce();
    expect(f.build.mock.calls[0]?.[0]).toBe(original);
    expect(f.cm.writeFile).toHaveBeenCalledWith(
      'container',
      '/home/autopod/.codex/auth.json',
      '{"token":"held-worker"}',
      undefined,
    );
    f.reopen();
  });
  it.each([false, true])(
    'remember callback keeps set/delete result identity before a held write; lineage=%s',
    async (has) => {
      const f = fixture();
      const result = controlledBuild(f, has);
      f.lineage.set('worker', {
        owner: { type: 'provider-account', id: 'selected' },
        issuedRefreshToken: 'old',
      });
      const entered = gate();
      const held = gate();
      vi.mocked(f.cm.writeFile).mockImplementationOnce(async () => {
        entered.release();
        await held.promise;
      });
      const pending = f.op.getResumeEnv(f.pod);
      try {
        await entered.promise;
        expect(f.remember).toHaveBeenCalledExactlyOnceWith('worker', result);
        expect(f.remember.mock.calls[0]?.[1]).toBe(result);
        expect(f.lineage.get('worker')).toEqual(result.maxCredentialLineage);
      } finally {
        held.release();
        await pending;
      }
      f.reopen();
    },
  );
  it.each([false, true])(
    'no-container still remembers result and launch capability work; launch=%s',
    async (composed) => {
      const f = fixture();
      f.pod.containerId = null;
      const l = composed ? await launch(f) : null;
      const result = controlledBuild(f, true);
      await f.op.getResumeEnv(f.pod);
      expect(f.remember).toHaveBeenCalledExactlyOnceWith('worker', result);
      expect(f.cm.readFile).not.toHaveBeenCalled();
      expect(f.cm.writeFile).not.toHaveBeenCalled();
      if (l) expect(l.check).toHaveBeenCalledOnce();
      f.reopen();
    },
  );
  it.each([false, true])(
    'sequential file/secret modes and final capability ordering remain launch=%s',
    async (composed) => {
      const f = fixture();
      const l = composed ? await launch(f) : null;
      controlledBuild(f);
      const steps: string[] = [];
      const entered = gate();
      const held = gate();
      vi.mocked(f.cm.writeFile).mockImplementation(async (_id, file, _data, options) => {
        const secret = file.includes('secret');
        expect(options).toEqual(composed ? { mode: secret ? 0o400 : 0o600 } : undefined);
        steps.push(`write:${file}`);
        if (file === '/fixture/a') {
          entered.release();
          await held.promise;
        }
      });
      vi.mocked(f.cm.execInContainer).mockImplementation(async (_id, args, options) => {
        expect(options).toEqual({ timeout: 5_000 });
        steps.push(`chmod:${args[2]}`);
        return { stdout: '', stderr: '', exitCode: 0 };
      });
      if (l)
        l.check.mockImplementation(async () => {
          steps.push('capabilities');
        });
      const pending = f.op.getResumeEnv(f.pod);
      try {
        await entered.promise;
        expect(steps).toEqual(['write:/fixture/a']);
      } finally {
        held.release();
        await pending;
      }
      expect(steps).toEqual(
        composed
          ? [
              'write:/fixture/a',
              'write:/fixture/b',
              'write:/fixture/secret-a',
              'write:/fixture/secret-b',
              'capabilities',
            ]
          : [
              'write:/fixture/a',
              'write:/fixture/b',
              'write:/fixture/secret-a',
              'chmod:/fixture/secret-a',
              'write:/fixture/secret-b',
              'chmod:/fixture/secret-b',
            ],
      );
      f.reopen();
    },
  );
  it.each([
    'profile',
    'validation',
    'build',
    'remember',
    'write-target',
    'first-write',
    'later-write',
    'secret',
    'chmod',
    'capability',
  ] as const)(
    '%s failure retains rejection identity and preceding lineage/write effects',
    async (stage) => {
      const f = fixture();
      const composed = stage === 'validation' || stage === 'capability';
      const l = composed ? await launch(f) : null;
      const result = controlledBuild(f, true);
      const error = new Error(`Controlled ${stage}`);
      const writes: string[] = [];
      f.openai.mockResolvedValue();
      if (stage === 'profile')
        f.bound.mockImplementation(() => {
          throw error;
        });
      if (stage === 'validation') f.validation.mockRejectedValue(error);
      if (stage === 'build') f.build.mockRejectedValue(error);
      if (stage === 'remember')
        f.remember.mockImplementation(() => {
          throw error;
        });
      if (stage === 'write-target')
        f.get
          .mockImplementationOnce(() => f.cm)
          .mockImplementation(() => {
            throw error;
          });
      vi.mocked(f.cm.writeFile).mockImplementation(async (_id, file) => {
        if (
          (stage === 'first-write' && file === '/fixture/a') ||
          (stage === 'later-write' && file === '/fixture/b') ||
          (stage === 'secret' && file === '/fixture/secret-a')
        )
          throw error;
        writes.push(file);
      });
      if (stage === 'chmod') vi.mocked(f.cm.execInContainer).mockRejectedValue(error);
      if (l && stage === 'capability') l.check.mockRejectedValue(error);
      await expect(f.op.getResumeEnv(f.pod)).rejects.toBe(error);
      expect(f.warn).not.toHaveBeenCalled();
      const remembered = !['profile', 'validation', 'build', 'remember'].includes(stage);
      expect(f.lineage.get('worker')).toEqual(remembered ? result.maxCredentialLineage : undefined);
      expect(writes).toEqual(
        stage === 'later-write'
          ? ['/fixture/a']
          : stage === 'secret'
            ? ['/fixture/a', '/fixture/b']
            : stage === 'chmod'
              ? ['/fixture/a', '/fixture/b', '/fixture/secret-a']
              : stage === 'capability'
                ? ['/fixture/a', '/fixture/b', '/fixture/secret-a', '/fixture/secret-b']
                : [],
      );
      f.reopen();
    },
  );
  it.each(['replacement', 'removed'] as const)(
    'late capability service %s during held write keeps original launch argument',
    async (change) => {
      const f = fixture();
      const l = await launch(f);
      controlledBuild(f);
      const entered = gate();
      const held = gate();
      vi.mocked(f.cm.writeFile).mockImplementationOnce(async () => {
        entered.release();
        await held.promise;
      });
      const next = vi.fn(async (_config: EffectiveLaunchConfig) => {});
      const pending = f.op.getResumeEnv(f.pod);
      try {
        await entered.promise;
        f.live.launchConfiguration =
          change === 'removed' ? undefined : { read: () => null, assertCurrentCapabilities: next };
      } finally {
        held.release();
        await pending;
      }
      expect(l.check).not.toHaveBeenCalled();
      expect(next).toHaveBeenCalledTimes(change === 'removed' ? 0 : 1);
      if (change === 'replacement') expect(next).toHaveBeenCalledExactlyOnceWith(l.config);
      f.reopen();
    },
  );
  it('env merge retains build values, provider precedence, final POD_ID and original builder arguments', async () => {
    const f = fixture();
    const l = await launch(f);
    const result = controlledBuild(f);
    await expect(f.op.getResumeEnv(f.pod)).resolves.toEqual({
      BUILD_ONLY: 'build',
      SHARED: 'provider',
      PROVIDER_ONLY: 'provider',
      POD_ID: 'worker',
    });
    const call = needed(f.build.mock.calls[0]);
    expect(call[0]).toBe(f.profile);
    expect(call[1]).toBe('worker');
    expect(call[2]).toBe(f.logger);
    expect(call[3]).toEqual({
      profileStore: f.profileStore,
      providerAccountStore: f.accounts,
      providerCatalog: PROVIDER_CATALOG,
      runtime: f.pod.runtime,
      providerBinding: { accountId: 'selected', providerId: 'openai' },
    });
    expect(f.remember.mock.calls[0]?.[1]).toBe(result);
    expect(l.check.mock.contexts[0]).toBe(l.service);
    f.reopen();
  });
  it('missing pod binding omits the conditional builder binding property', async () => {
    const f = fixture();
    f.pod.providerIdSnapshot = null;
    controlledBuild(f);
    await f.op.getResumeEnv(f.pod);
    expect(f.build.mock.calls[0]?.[3]).not.toHaveProperty('providerBinding');
    f.reopen();
  });
  it('real credential SQL abort is caught, warns and rewrites old auth without changing other durable rows', async () => {
    const f = fixture();
    vi.mocked(f.cm.readFile).mockResolvedValue('{"token":"unpersisted-worker"}');
    f.db().exec(
      "CREATE TRIGGER reject_worker_credentials BEFORE UPDATE OF credentials ON provider_accounts WHEN OLD.id='selected' BEGIN SELECT RAISE(ABORT,'worker auth rejected'); END",
    );
    await expect(f.op.getResumeEnv(f.pod)).resolves.toMatchObject({ POD_ID: 'worker' });
    expect(f.warn).toHaveBeenCalledWith(
      { err: expect.objectContaining({ message: 'worker auth rejected' }), podId: 'worker' },
      'Could not recover Codex auth.json from container before resume',
    );
    expect(f.cm.writeFile).toHaveBeenCalledWith(
      'container',
      '/home/autopod/.codex/auth.json',
      '{"token":"fixture-old"}',
      undefined,
    );
    expect(f.reopen().accounts.get('selected').credentials).toEqual(f.initial);
  });
});

describe('worker post-run credential persistence', () => {
  it('missing pod lookup propagates outside catch; missing container returns before bound-profile lookup', async () => {
    const f = fixture();
    const error = new Error('Pod read failed');
    f.readPod.mockImplementationOnce(() => {
      throw error;
    });
    await expect(f.op.persistRuntimeCredentialsForPod('worker', 'caller')).rejects.toBe(error);
    expect(f.warn).not.toHaveBeenCalled();
    f.repo.update('worker', { containerId: null });
    await f.op.persistRuntimeCredentialsForPod('worker', 'caller');
    expect(f.bound).not.toHaveBeenCalled();
    expect(f.get).not.toHaveBeenCalled();
    f.reopen();
  });
  it.each(['anthropic', 'foundry', 'copilot', 'openrouter', null] as const)(
    'unsupported provider=%s returns without readback/build/map effects',
    async (provider) => {
      const f = fixture();
      f.profile.modelProvider = provider;
      await f.op.persistRuntimeCredentialsForPod('worker', 'caller');
      expect(f.bound).toHaveBeenCalledOnce();
      expect(f.cm.readFile).not.toHaveBeenCalled();
      expect(f.build).not.toHaveBeenCalled();
      expect(f.remember).not.toHaveBeenCalled();
      f.reopen();
    },
  );
  it.each(['openai', 'pi', 'max'] as const)(
    'actual %s readback persists local auth without env build or container writes',
    async (provider) => {
      const f = fixture(provider);
      const fresh =
        provider === 'openai'
          ? '{"token":"post-worker"}'
          : '{"anthropic":{"access":"post-worker"}}';
      vi.mocked(f.cm.readFile).mockResolvedValue(fresh);
      await f.op.persistRuntimeCredentialsForPod('worker', 'caller');
      expect(f.build).not.toHaveBeenCalled();
      expect(f.remember).not.toHaveBeenCalled();
      expect(f.cm.writeFile).not.toHaveBeenCalled();
      expect(f.cm.execInContainer).not.toHaveBeenCalled();
      const saved = f.reopen().accounts.get('selected').credentials;
      expect(saved).toMatchObject(
        provider === 'openai'
          ? { provider, authJson: fresh }
          : provider === 'pi'
            ? { provider, credential: { access: 'post-worker' } }
            : f.initial,
      );
      expect(globalThis.fetch).not.toHaveBeenCalled();
    },
  );
  it.each(['profile', 'target', 'helper'] as const)(
    '%s failure is swallowed and warned exactly once with supplied caller message',
    async (stage) => {
      const f = fixture();
      const error = new Error(`Post-run ${stage}`);
      if (stage === 'profile')
        f.bound.mockImplementation(() => {
          throw error;
        });
      if (stage === 'target')
        f.get.mockImplementation(() => {
          throw error;
        });
      if (stage === 'helper') f.openai.mockRejectedValue(error);
      await expect(
        f.op.persistRuntimeCredentialsForPod('worker', 'original caller message'),
      ).resolves.toBeUndefined();
      expect(f.warn).toHaveBeenCalledExactlyOnceWith(
        { err: error, podId: 'worker' },
        'original caller message',
      );
      expect(f.build).not.toHaveBeenCalled();
      f.reopen();
    },
  );
  it('a thrown warning logger is not caught again', async () => {
    const f = fixture();
    const error = new Error('Warning failed');
    f.openai.mockRejectedValue(new Error('Readback failed'));
    f.warn.mockImplementation(() => {
      throw error;
    });
    await expect(f.op.persistRuntimeCredentialsForPod('worker', 'caller')).rejects.toBe(error);
    expect(f.warn).toHaveBeenCalledOnce();
    f.reopen();
  });
  it.each(['absent', 'different'] as const)(
    'fresh profile owner=%s is forwarded rather than pod account snapshot',
    async (owner) => {
      const f = fixture();
      f.profile.providerAccountId = owner === 'absent' ? null : 'other';
      f.openai.mockResolvedValue();
      await f.op.persistRuntimeCredentialsForPod('worker', 'caller');
      expect(f.openai.mock.calls[0]).toEqual([
        'container',
        f.cm,
        f.profileStore,
        'test-profile',
        f.logger,
        {
          providerAccountStore: f.accounts,
          owner: owner === 'absent' ? undefined : { type: 'provider-account', id: 'other' },
        },
      ]);
      f.reopen();
    },
  );
  it('MAX readback uses the current map entry and selected profile without mutating lineage', async () => {
    const f = fixture('max');
    const entry: MaxCredentialLineage = {
      owner: { type: 'provider-account', id: 'selected' },
      issuedRefreshToken: 'late-map',
    };
    f.lineage.set('worker', entry);
    const get = vi.spyOn(f.lineage, 'get');
    await f.op.persistRuntimeCredentialsForPod('worker', 'caller');
    expect(f.max.mock.calls[0]?.[5]).toBe(entry);
    expect(get).toHaveBeenCalledExactlyOnceWith('worker');
    expect(f.remember).not.toHaveBeenCalled();
    expect(f.lineage.get('worker')).toBe(entry);
    f.reopen();
  });
  it('real account SQL failure is swallowed by post-run wrapper with durable account/attempt prefix unchanged', async () => {
    const f = fixture();
    f.openAttempt(true);
    const rows = f.attempts.listRaw('worker');
    vi.mocked(f.cm.readFile).mockResolvedValue('{"token":"post-aborted"}');
    f.db().exec(
      "CREATE TRIGGER reject_post_auth BEFORE UPDATE OF credentials ON provider_accounts WHEN OLD.id='selected' BEGIN SELECT RAISE(ABORT,'post auth rejected'); END",
    );
    await expect(
      f.op.persistRuntimeCredentialsForPod('worker', 'readback caller'),
    ).resolves.toBeUndefined();
    expect(f.warn).toHaveBeenCalledExactlyOnceWith(
      { err: expect.objectContaining({ message: 'post auth rejected' }), podId: 'worker' },
      'readback caller',
    );
    const reopened = f.reopen();
    expect(reopened.accounts.get('selected').credentials).toEqual(f.initial);
    expect(reopened.attempts).toEqual(rows);
  });
  it('retains all captured collaborator identities while observing late object/map methods', async () => {
    const f = fixture('max');
    const l = await launch(f);
    controlledBuild(f);
    const factory = f.captured.containerManagerFactory;
    const lateGet = vi.fn(() => f.cm);
    factory.get = lateGet;
    const get = vi.spyOn(f.lineage, 'get');
    f.captured.podRepo = {
      getOrThrow: () => {
        throw new Error('Replacement repo');
      },
    };
    f.captured.providerAccountStore = undefined;
    f.captured.providerCatalog = { ...PROVIDER_CATALOG, providers: [] };
    f.captured.profileStore = {
      ...f.profileStore,
      get: () => {
        throw new Error('Replacement profile store');
      },
    };
    f.captured.containerManagerFactory = {
      get: () => {
        throw new Error('Replacement factory');
      },
    };
    f.captured.logger = pino({ level: 'silent' });
    f.captured.maxCredentialLineageByPod = new Map();
    f.captured.resolveEffectiveBoundProfile = () => {
      throw new Error('Replacement profile function');
    };
    f.captured.validationEnvironmentForPod = async () => {
      throw new Error('Replacement validation');
    };
    f.captured.rememberMaxCredentialLineage = () => {
      throw new Error('Replacement remember');
    };
    const read = f.repo.getOrThrow.bind(f.repo);
    const lateRead = vi.fn(read);
    f.repo.getOrThrow = lateRead;
    await f.op.getResumeEnv(f.pod);
    await f.op.persistRuntimeCredentialsForPod('worker', 'caller');
    expect(f.validation).toHaveBeenCalledOnce();
    expect(f.remember).toHaveBeenCalledOnce();
    expect(f.bound).toHaveBeenCalledTimes(2);
    expect(l.check).toHaveBeenCalledOnce();
    expect(lateGet).toHaveBeenCalledTimes(3);
    expect(lateRead).toHaveBeenCalledExactlyOnceWith('worker');
    expect(get).toHaveBeenCalledWith('worker');
    expect(f.build.mock.calls[0]?.[2]).toBe(f.logger);
    expect(f.build.mock.calls[0]?.[3]).toMatchObject({
      profileStore: f.profileStore,
      providerAccountStore: f.accounts,
      providerCatalog: PROVIDER_CATALOG,
    });
    f.reopen();
  });
  it('late capability failure retains actual rotated account auth after mode0600 writes and reopen', async () => {
    const f = fixture();
    const l = await launch(f);
    const fresh = '{"token":"worker-before-capability"}';
    vi.mocked(f.cm.readFile).mockResolvedValue(fresh);
    const error = new Error('Capabilities revoked after write');
    l.check.mockRejectedValue(error);
    await expect(f.op.getResumeEnv(f.pod)).rejects.toBe(error);
    expect(f.cm.writeFile).toHaveBeenCalledWith(
      'container',
      '/home/autopod/.codex/auth.json',
      fresh,
      { mode: 0o600 },
    );
    expect(f.remember).toHaveBeenCalledOnce();
    expect(f.reopen().accounts.get('selected').credentials).toMatchObject({ authJson: fresh });
  });

  it('a live launch-property read failure propagates after initial binding and before recovery', async () => {
    const f = fixture();
    const error = new Error('Live launch read');
    Object.defineProperty(f.live, 'launchConfiguration', {
      configurable: true,
      get() {
        throw error;
      },
    });
    await expect(f.op.getResumeEnv(f.pod)).rejects.toBe(error);
    expect(f.bound).toHaveBeenCalledOnce();
    expect(f.warn).not.toHaveBeenCalled();
    expect(f.build).not.toHaveBeenCalled();
    f.reopen();
  });

  it('actual MAX post-run rotation preserves current account metadata and existing lineage without issuing env', async () => {
    const f = fixture('max');
    const old = {
      provider: 'max' as const,
      accessToken: 'post-old',
      refreshToken: 'post-old-refresh',
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      clientId: 'fixture-client',
    };
    f.accounts.updateCredentials('selected', old);
    f.profile.providerCredentials = old;
    const lineage: MaxCredentialLineage = {
      owner: { type: 'provider-account', id: 'selected' },
      issuedRefreshToken: old.refreshToken,
    };
    f.lineage.set('worker', lineage);
    const nextExpiry = Date.now() + 7_200_000;
    vi.mocked(f.cm.readFile).mockResolvedValue(
      JSON.stringify({
        claudeAiOauth: {
          accessToken: 'post-new',
          refreshToken: 'post-new-refresh',
          expiresAt: nextExpiry,
        },
      }),
    );
    await f.op.persistRuntimeCredentialsForPod('worker', 'MAX readback');
    expect(f.build).not.toHaveBeenCalled();
    expect(f.cm.writeFile).not.toHaveBeenCalled();
    expect(f.remember).not.toHaveBeenCalled();
    expect(f.lineage.get('worker')).toBe(lineage);
    expect(f.reopen().accounts.get('selected').credentials).toMatchObject({
      provider: 'max',
      accessToken: 'post-new',
      refreshToken: 'post-new-refresh',
      expiresAt: new Date(nextExpiry).toISOString(),
      clientId: 'fixture-client',
    });
  });
});
