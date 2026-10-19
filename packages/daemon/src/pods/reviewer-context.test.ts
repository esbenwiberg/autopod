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
import type { ReviewerExecutor } from '../interfaces/reviewer-executor.js';
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
import { createReviewerContext } from './reviewer-context.js';

const cleanup: Array<() => void> = [];
beforeEach(() => {
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(
    new Error('External network forbidden in reviewer context fixture'),
  );
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.useRealTimers();
  for (const close of cleanup.splice(0).reverse()) close();
});
function needed<T>(value: T | null | undefined): T {
  if (value == null) throw new Error('Missing reviewer fixture');
  return value;
}
function gate() {
  let release = () => {};
  const promise = new Promise<void>((done) => {
    release = done;
  });
  return { promise, release };
}
function caught(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error('Expected rejection');
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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reviewer-context-'));
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
  const execution = vi.fn((_pod: Pod): PodExecutionSettings => profile);
  const bound = vi.fn((_pod: Pod): PodExecutionSettings => profile);
  const logger = pino({ level: 'silent' });
  const warn = vi.spyOn(logger, 'warn');
  const lineage = new Map<string, MaxCredentialLineage>();
  const live: Parameters<typeof createReviewerContext>[0] = {};
  const captured: Parameters<typeof createReviewerContext>[1] = {
    providerAccountStore: accounts,
    providerCatalog: PROVIDER_CATALOG,
    profileStore,
    containerManagerFactory: { get },
    logger,
    maxCredentialLineageByPod: lineage,
    executionForPod: execution,
    resolveEffectiveBoundProfile: bound,
  };
  const op = createReviewerContext(live, captured);
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
    execution,
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
async function launch(f: ReturnType<typeof fixture>, mode: 'independent' | 'follow-main') {
  const { store, services } = createTestConfiguration(f.db());
  f.accounts.create({
    id: 'account',
    name: 'Main',
    provider: 'anthropic',
    credentials: { provider: 'anthropic', apiKey: 'fixture-main' },
  });
  f.accounts.create({
    id: 'reviewer',
    name: 'Reviewer',
    provider: 'anthropic',
    credentials: { provider: 'anthropic', apiKey: 'fixture-reviewer' },
  });
  services.resolveAgentRoute = async (route) => resolveLaunchAgentRoute(route, f.accounts);
  const config = await resolveLaunch(
    {
      repositoryId: 'repo-a',
      task: 'Reviewer context',
      ...(mode === 'independent'
        ? {
            overrides: {
              ai: {
                reviewer: {
                  mode,
                  route: {
                    providerAccountId: 'reviewer',
                    runtime: 'claude',
                    model: 'sonnet',
                    reasoningEffort: 'high',
                  },
                },
              },
            },
          }
        : {}),
    },
    services,
  );
  const executor = vi.fn<ReviewerExecutor>(async () => ({ stdout: 'Local' }));
  const select = vi.fn(
    (
      _pod: Pod,
      _launch: EffectiveLaunchConfig,
      _route: EffectiveLaunchConfig['ai']['main'],
      _purpose: 'review' | 'memory' = 'review',
    ) => executor,
  );
  const service = { executor: select };
  const read = vi.fn((_id: string) => config);
  f.live.launchConfiguration = { read, reviewer: service };
  f.pod.launchConfigDigest = config.digest;
  return { config, executor, select, service, read, store };
}
function controlledBuild(f: ReturnType<typeof fixture>) {
  const result: ProviderEnvResult = {
    env: { FIXTURE: 'ready', POD_ID: 'builder-wins' },
    containerFiles: [
      { path: '/fixture/a', content: 'a' },
      { path: '/fixture/b', content: 'b' },
    ],
    secretFiles: [
      { path: '/fixture/secret-a', content: 'secret-a' },
      { path: '/fixture/secret-b', content: 'secret-b' },
    ],
    requiresPostExecPersistence: false,
  };
  f.build.mockResolvedValue(result);
  return result;
}

describe('reviewer configuration and executor', () => {
  it('constructs without collaborator work and retains no-digest executor early return', () => {
    const f = fixture();
    const read = vi.fn(() => {
      throw new Error('No read');
    });
    f.live.launchConfiguration = { read };
    expect(f.execution).not.toHaveBeenCalled();
    expect(f.bound).not.toHaveBeenCalled();
    expect(f.get).not.toHaveBeenCalled();
    expect(f.build).not.toHaveBeenCalled();
    expect(f.op.getReviewerExecutor(f.pod)).toBeUndefined();
    expect(read).not.toHaveBeenCalled();
    expect(f.reopen().attempts).toEqual([]);
  });
  it.each(['absent', 'empty', 'open', 'closed'] as const)(
    'legacy %s history preserves resolver and credential authority',
    (history) => {
      const f = fixture();
      f.pod.profileSnapshot = {
        ...f.profileStore.get('test-profile'),
        modelProvider: 'anthropic',
        providerAccountId: 'other',
        defaultRuntime: 'claude',
        defaultModel: 'snapshot-model',
        reviewerModel: 'snapshot-review',
      };
      if (history !== 'absent') f.live.providerAttemptRepo = f.attempts;
      if (history === 'open' || history === 'closed') f.openAttempt(history === 'closed');
      const rows = f.attempts.listRaw('worker');
      const result = f.op.getEffectiveReviewerConfig(f.pod);
      const bound = history === 'open' || history === 'closed';
      expect(result.profile.providerAccountId).toBe(bound ? 'selected' : 'other');
      expect(result.profile.defaultModel).toBe(bound ? 'main-model' : 'snapshot-model');
      expect(result.credentials).toEqual(bound ? f.initial : f.other.credentials);
      expect(f.bound).toHaveBeenCalledTimes(bound ? 1 : 0);
      expect(f.execution).toHaveBeenCalledTimes(bound ? 0 : 1);
      expect(f.reopen().attempts).toEqual(rows);
    },
  );
  it.each([false, true])(
    'legacy keeps profile credential fallback without an account; digest=%s',
    (digest) => {
      const f = fixture('anthropic');
      f.profile.providerAccountId = null;
      f.pod.launchConfigDigest = digest ? 'digest' : null;
      const result = f.op.getEffectiveReviewerConfig(f.pod);
      expect(result.credentials).toBe(f.profile.providerCredentials);
      expect(result.profile).toBe(f.profile);
      expect(f.reopen().attempts).toEqual([]);
    },
  );
  it.each(['legacy', 'follow-main'] as const)(
    '%s preserves null credentials when captured account storage is absent',
    async (mode) => {
      const f = fixture();
      f.captured.providerAccountStore = undefined;
      const op = createReviewerContext(f.live, f.captured);
      if (mode === 'follow-main') await launch(f, mode);
      expect(op.getEffectiveReviewerConfig(f.pod).credentials).toBeNull();
      f.reopen();
    },
  );
  it('digest fallback rejects missing credentials after profile resolution, retaining earlier read errors', () => {
    const f = fixture();
    f.pod.launchConfigDigest = 'digest';
    f.profile.providerAccountId = null;
    f.profile.providerCredentials = null;
    expect(caught(() => f.op.getEffectiveReviewerConfig(f.pod))).toMatchObject({
      code: 'PROVIDER_CREDENTIALS_MISSING',
      statusCode: 409,
    });
    const error = new Error('Snapshot missing');
    f.execution.mockImplementation(() => {
      throw error;
    });
    expect(caught(() => f.op.getEffectiveReviewerConfig(f.pod))).toBe(error);
    f.reopen();
  });
  it.each(['independent', 'follow-main'] as const)(
    '%s uses actual account credentials and correct profile copies',
    async (mode) => {
      const f = fixture();
      const l = await launch(f, mode);
      const result = f.op.getEffectiveReviewerConfig(f.pod);
      if (mode === 'independent') {
        expect(result.profile).toMatchObject({
          providerAccountId: 'reviewer',
          modelProvider: 'anthropic',
          defaultRuntime: 'claude',
          defaultModel: 'sonnet',
          reviewerModel: 'sonnet',
          reasoningEffort: 'high',
          providerFailover: { targets: [], maxHops: 0 },
        });
        expect(result.credentials).toEqual({ provider: 'anthropic', apiKey: 'fixture-reviewer' });
        expect(f.bound).not.toHaveBeenCalled();
        expect(result.profile.smokePages).toBe(f.profile.smokePages);
        f.accounts.updateCredentials('account', null);
        expect(f.op.getEffectiveReviewerConfig(f.pod).profile.providerAccountId).toBe('reviewer');
      } else {
        expect(result.profile).toEqual({ ...f.profile, reviewerModel: 'main-model' });
        expect(result.profile).not.toBe(f.profile);
        expect(result.credentials).toEqual(f.initial);
      }
      expect(l.select).not.toHaveBeenCalled();
      f.reopen();
    },
  );
  it.each(['store', 'credentials', 'createdAt', 'runtime', 'catalog'] as const)(
    'independent retains %s rejection and precedence',
    async (failure) => {
      const f = fixture();
      const l = await launch(f, 'independent');
      const captured = { ...f.captured };
      if (failure === 'store') captured.providerAccountStore = undefined;
      if (failure === 'credentials') f.accounts.updateCredentials('reviewer', null);
      if (failure === 'createdAt')
        f.db()
          .prepare("UPDATE provider_accounts SET created_at='changed' WHERE id='reviewer'")
          .run();
      if (failure === 'runtime' && l.config.ai.reviewer.mode === 'independent')
        l.config.ai.reviewer.route.runtime = 'codex';
      if (failure === 'catalog')
        captured.providerCatalog = {
          ...PROVIDER_CATALOG,
          providers: PROVIDER_CATALOG.providers.map((p) =>
            p.id === 'anthropic' ? { ...p, policy: { ...p.policy, runnable: false } } : p,
          ),
        };
      const op = createReviewerContext(f.live, captured);
      const codes = {
        store: 'PROVIDER_ACCOUNT_STORE_MISSING',
        credentials: 'PROVIDER_CREDENTIALS_MISSING',
        createdAt: 'PROVIDER_BINDING_MISMATCH',
        runtime: 'PROVIDER_RUNTIME_MISMATCH',
        catalog: 'PROVIDER_ACCOUNT_NOT_RUNNABLE',
      };
      expect(caught(() => op.getEffectiveReviewerConfig(f.pod))).toMatchObject({
        code: codes[failure],
      });
      expect(f.execution).not.toHaveBeenCalled();
      expect(l.select).not.toHaveBeenCalled();
      f.reopen();
    },
  );
  it('follow-main with no account returns null rather than profile credentials', async () => {
    const f = fixture();
    await launch(f, 'follow-main');
    f.profile.providerAccountId = null;
    const result = f.op.getEffectiveReviewerConfig(f.pod);
    expect(result.credentials).toBeNull();
    expect(result.profile.reviewerModel).toBe('main-model');
    f.reopen();
  });
  it.each(['launch', 'reviewer'] as const)(
    'digest executor requires %s before resolving profiles',
    async (missing) => {
      const f = fixture();
      const l = await launch(f, 'independent');
      if (missing === 'launch')
        f.live.launchConfiguration = { read: () => null, reviewer: l.service };
      else needed(f.live.launchConfiguration).reviewer = undefined;
      expect(caught(() => f.op.getReviewerExecutor(f.pod))).toMatchObject({
        code: 'REVIEWER_ISOLATION_REQUIRED',
        statusCode: 503,
      });
      expect(f.execution).not.toHaveBeenCalled();
      expect(f.bound).not.toHaveBeenCalled();
      expect(l.select).not.toHaveBeenCalled();
      f.reopen();
    },
  );
  it.each(
    (['independent', 'follow-main'] as const).flatMap((mode) =>
      ([undefined, 'review', 'memory'] as const).map((purpose) => ({ mode, purpose })),
    ),
  )(
    '$mode forwards purpose=$purpose, receiver, route identity and uninvoked executor',
    async ({ mode, purpose }) => {
      const f = fixture();
      const l = await launch(f, mode);
      expect(f.op.getReviewerExecutor(f.pod, purpose)).toBe(l.executor);
      const call = needed(l.select.mock.calls[0]);
      expect(call[0]).toBe(f.pod);
      expect(call[1]).toBe(l.config);
      expect(call[3]).toBe(purpose ?? 'review');
      expect(l.select.mock.contexts[0]).toBe(l.service);
      const route =
        l.config.ai.reviewer.mode === 'independent' ? l.config.ai.reviewer.route : l.config.ai.main;
      if (mode === 'independent') expect(call[2]).toBe(route);
      else {
        expect(call[2]).not.toBe(route);
        expect(call[2]).toEqual({
          ...route,
          providerAccountId: 'selected',
          runtime: 'codex',
          model: 'main-model',
          reasoningEffort: 'high',
        });
      }
      expect(l.executor).not.toHaveBeenCalled();
      f.reopen();
    },
  );
  it.each(['providerAccountId', 'defaultRuntime', 'defaultModel', 'reasoningEffort'] as const)(
    'follow-main preserves nullish %s fallback',
    async (field) => {
      const f = fixture();
      const l = await launch(f, 'follow-main');
      f.profile[field] = null;
      f.op.getReviewerExecutor(f.pod);
      const route = needed(l.select.mock.calls[0]?.[2]);
      const key =
        field === 'defaultRuntime' ? 'runtime' : field === 'defaultModel' ? 'model' : field;
      expect(Reflect.get(route, key)).toEqual(Reflect.get(l.config.ai.main, key));
      f.reopen();
    },
  );
  it('retains live launch/history reads, repeated launch resolution and late service methods', async () => {
    const f = fixture();
    const l = await launch(f, 'independent');
    const first = f.op.getReviewerExecutor(f.pod);
    expect(first).toBe(l.executor);
    expect(l.read).toHaveBeenCalledTimes(2);
    const replacement = vi.fn(() => l.executor);
    l.service.executor = replacement;
    const read = vi.fn(() => l.config);
    f.live.launchConfiguration = { read, reviewer: l.service };
    f.op.getReviewerExecutor(f.pod);
    expect(read).toHaveBeenCalledTimes(2);
    expect(replacement).toHaveBeenCalledOnce();
    f.live.launchConfiguration = undefined;
    f.pod.launchConfigDigest = null;
    f.live.providerAttemptRepo = f.attempts;
    f.openAttempt(true);
    f.op.getEffectiveReviewerConfig(f.pod);
    expect(f.bound).toHaveBeenCalledOnce();
    f.live.providerAttemptRepo = { list: () => [] };
    f.op.getEffectiveReviewerConfig(f.pod);
    expect(f.execution).toHaveBeenCalledTimes(3);
    f.reopen();
  });
  it.each(['read', 'history', 'account', 'executor'] as const)(
    'propagates %s rejection by identity',
    async (stage) => {
      const f = fixture();
      const error = new Error(`fixture ${stage}`);
      if (stage === 'read')
        f.live.launchConfiguration = {
          read: () => {
            throw error;
          },
        };
      if (stage === 'history')
        f.live.providerAttemptRepo = {
          list: () => {
            throw error;
          },
        };
      if (stage === 'account')
        vi.spyOn(f.accounts, 'get').mockImplementation(() => {
          throw error;
        });
      if (stage === 'executor') {
        const l = await launch(f, 'follow-main');
        l.select.mockImplementation(() => {
          throw error;
        });
      }
      expect(
        caught(() =>
          stage === 'executor'
            ? f.op.getReviewerExecutor(f.pod)
            : f.op.getEffectiveReviewerConfig(f.pod),
        ),
      ).toBe(error);
      if (stage === 'account') vi.mocked(f.accounts.get).mockRestore();
      f.reopen();
    },
  );
});

describe('reviewer environment', () => {
  it('digest env checks isolation then returns no legacy env or worker writes', async () => {
    const f = fixture();
    const l = await launch(f, 'independent');
    await expect(f.op.buildReviewerExecEnv(f.pod)).resolves.toBeUndefined();
    expect(l.select).toHaveBeenCalledOnce();
    expect(l.executor).not.toHaveBeenCalled();
    expect(f.build).not.toHaveBeenCalled();
    expect(f.get).not.toHaveBeenCalled();
    f.reopen();
  });
  it('non-digest independent guard follows configuration resolution before any recovery/build', async () => {
    const f = fixture();
    await launch(f, 'independent');
    f.pod.launchConfigDigest = null;
    await expect(f.op.buildReviewerExecEnv(f.pod)).rejects.toMatchObject({
      code: 'REVIEWER_ISOLATION_REQUIRED',
      statusCode: 503,
    });
    expect(f.execution).toHaveBeenCalledOnce();
    expect(f.build).not.toHaveBeenCalled();
    expect(f.get).not.toHaveBeenCalled();
    f.reopen();
  });
  it.each(['anthropic', 'copilot', 'openrouter', null] as const)(
    'provider=%s returns undefined before legacy auth work',
    async (provider) => {
      const f = fixture();
      f.profile.modelProvider = provider;
      await expect(f.op.buildReviewerExecEnv(f.pod)).resolves.toBeUndefined();
      expect(f.build).not.toHaveBeenCalled();
      expect(f.get).not.toHaveBeenCalled();
      f.reopen();
    },
  );
  it.each(
    (['max', 'openai', 'pi', 'foundry'] as const).flatMap((provider) =>
      [false, true].map((container) => ({ provider, container })),
    ),
  )(
    'actual $provider with container=$container uses local auth and sequential writes',
    async ({ provider, container }) => {
      const f = fixture(provider);
      if (!container) f.pod.containerId = null;
      const result = await f.op.buildReviewerExecEnv(f.pod);
      expect(result).toMatchObject({ POD_ID: 'worker' });
      expect(f.build).toHaveBeenCalledOnce();
      expect(globalThis.fetch).not.toHaveBeenCalled();
      expect(f.max).toHaveBeenCalledTimes(provider === 'max' && container ? 1 : 0);
      expect(f.openai).toHaveBeenCalledTimes(provider === 'openai' && container ? 1 : 0);
      expect(f.pi).toHaveBeenCalledTimes(provider === 'pi' && container ? 1 : 0);
      expect(f.execution).toHaveBeenCalledTimes(container && provider !== 'foundry' ? 2 : 1);
      if (container) {
        expect(f.cm.writeFile).toHaveBeenCalled();
        if (provider === 'max' || provider === 'foundry')
          expect(f.cm.execInContainer).toHaveBeenCalledWith(
            'container',
            ['chmod', '0400', expect.any(String)],
            { timeout: 5_000 },
          );
      } else expect(f.cm.writeFile).not.toHaveBeenCalled();
      expect(f.reopen().attempts).toEqual([]);
    },
  );
  it.each(['openai', 'pi'] as const)(
    'actual %s rotation persists only the pod-selected account and survives reopen/later file failure',
    async (provider) => {
      const f = fixture(provider);
      const fresh =
        provider === 'openai' ? '{"token":"rotated"}' : '{"anthropic":{"access":"rotated"}}';
      vi.mocked(f.cm.readFile).mockResolvedValue(fresh);
      const error = new Error('Later auth write');
      vi.mocked(f.cm.writeFile).mockImplementation(async (_id, file) => {
        if (file.endsWith('/auth.json')) throw error;
      });
      await expect(f.op.buildReviewerExecEnv(f.pod)).rejects.toBe(error);
      const selected = f.reopen().accounts.get('selected').credentials;
      expect(selected).toMatchObject(
        provider === 'openai'
          ? { provider, authJson: fresh }
          : { provider, credential: { access: 'rotated' } },
      );
      expect(f.execution).toHaveBeenCalledTimes(2);
      expect(f.cm.writeFile).toHaveBeenCalledTimes(3);
      expect(globalThis.fetch).not.toHaveBeenCalled();
    },
  );
  it('actual nonexpired MAX keeps existing lineage map untouched and requires no remote refresh', async () => {
    const f = fixture('max');
    const creds: ProviderCredentials = {
      provider: 'max',
      accessToken: 'fixture-access',
      refreshToken: 'fixture-refresh',
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      clientId: 'fixture-client',
    };
    f.accounts.updateCredentials('selected', creds);
    const lineage: MaxCredentialLineage = {
      owner: { type: 'provider-account', id: 'selected' },
      issuedRefreshToken: 'fixture-refresh',
    };
    f.lineage.set('worker', lineage);
    const get = vi.spyOn(f.lineage, 'get');
    await f.op.buildReviewerExecEnv(f.pod);
    expect(get).toHaveBeenCalledExactlyOnceWith('worker');
    expect(f.max.mock.calls[0]?.[5]).toBe(lineage);
    expect(f.lineage.get('worker')).toBe(lineage);
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(f.reopen().accounts.get('selected').credentials).toEqual(creds);
  });
  it.each(['success', 'failure'] as const)(
    'Foundry token acquisition %s stays at existing controlled token boundary',
    async (outcome) => {
      const f = fixture('foundry');
      f.accounts.updateCredentials('selected', {
        provider: 'foundry',
        endpoint: 'https://fixture.services.ai.azure.com',
      });
      const error = new Error('Fixture token unavailable');
      const token = vi.spyOn(azureTokens, 'getAzureToken');
      if (outcome === 'failure') token.mockRejectedValue(error);
      else
        token.mockResolvedValue({ token: 'fixture-bearer', expiresAtMs: Date.now() + 3_600_000 });
      const pending = f.op.buildReviewerExecEnv(f.pod);
      if (outcome === 'failure') await expect(pending).rejects.toBe(error);
      else {
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
  it.each(['max', 'openai', 'pi'] as const)(
    '%s recovery preserves pod owner and warning/re-read after caught failure',
    async (provider) => {
      const f = fixture(provider);
      const recovery = provider === 'max' ? f.max : provider === 'openai' ? f.openai : f.pi;
      const error = new Error('Controlled recovery unavailable');
      recovery.mockRejectedValue(error);
      f.profile.providerAccountId = 'other'; // Recovery owner remains the pod snapshot, even when config differs.
      controlledBuild(f);
      await f.op.buildReviewerExecEnv(f.pod);
      const args = needed(recovery.mock.calls[0]);
      expect(args[0]).toBe('container');
      expect(args[1]).toBe(f.cm);
      expect(args.at(-1)).toEqual({
        providerAccountStore: f.accounts,
        owner: { type: 'provider-account', id: 'selected' },
      });
      expect(f.warn).toHaveBeenCalledWith(
        { err: error, podId: 'worker', provider },
        'Could not recover credentials from container before reviewer call',
      );
      expect(f.execution).toHaveBeenCalledTimes(2);
      expect(f.build).toHaveBeenCalledOnce();
      f.reopen();
    },
  );
  it('keeps captured collaborators, late methods, conditional binding and runtime arguments', async () => {
    const f = fixture('max');
    controlledBuild(f);
    const factory = f.captured.containerManagerFactory;
    const late = vi.fn(() => f.cm);
    factory.get = late;
    const retained = f.profile;
    f.captured.executionForPod = () => {
      throw new Error('Replacement function');
    };
    f.captured.profileStore = {
      ...f.profileStore,
      get: () => {
        throw new Error('Replacement store');
      },
    };
    f.captured.containerManagerFactory = {
      get: () => {
        throw new Error('Replacement factory');
      },
    };
    f.captured.providerAccountStore = undefined;
    f.captured.maxCredentialLineageByPod = new Map();
    const get = vi.spyOn(f.accounts, 'get');
    const mapGet = vi.spyOn(f.lineage, 'get');
    await f.op.buildReviewerExecEnv(f.pod);
    const call = needed(f.build.mock.calls[0]);
    expect(call[0]).toEqual({ ...retained, providerCredentials: f.initial });
    expect(call[2]).toBe(f.logger);
    expect(call[3]).toMatchObject({
      profileStore: f.profileStore,
      providerAccountStore: f.accounts,
      providerCatalog: PROVIDER_CATALOG,
      runtime: 'claude',
      providerBinding: { accountId: 'selected', providerId: 'max' },
    });
    expect(get).toHaveBeenCalled();
    expect(mapGet).toHaveBeenCalledWith('worker');
    expect(late).toHaveBeenCalledTimes(2);
    f.reopen();
  });
  it('omits provider binding when absent and keeps builder spread precedence', async () => {
    const f = fixture();
    f.pod.containerId = null;
    f.pod.providerIdSnapshot = null;
    controlledBuild(f);
    await expect(f.op.buildReviewerExecEnv(f.pod)).resolves.toEqual({
      POD_ID: 'builder-wins',
      FIXTURE: 'ready',
    });
    expect(f.build.mock.calls[0]?.[3]).not.toHaveProperty('providerBinding');
    f.reopen();
  });
  it('awaits recovery before resolving config again and keeps fresh credentials in builder inputs', async () => {
    const f = fixture();
    const entered = gate();
    const held = gate();
    f.openai.mockImplementation(async () => {
      entered.release();
      await held.promise;
      f.accounts.updateCredentials('selected', {
        provider: 'openai',
        authJson: '{"token":"held-new"}',
      });
    });
    controlledBuild(f);
    const pending = f.op.buildReviewerExecEnv(f.pod);
    try {
      await entered.promise;
      expect(f.execution).toHaveBeenCalledOnce();
      expect(f.build).not.toHaveBeenCalled();
    } finally {
      held.release();
      await pending;
    }
    expect(f.build.mock.calls[0]?.[0].providerCredentials).toMatchObject({
      authJson: '{"token":"held-new"}',
    });
    expect(f.reopen().accounts.get('selected').credentials).toMatchObject({
      authJson: '{"token":"held-new"}',
    });
  });
  it('writes container files then each secret/chmod sequentially with existing modes and timeout', async () => {
    const f = fixture('foundry');
    controlledBuild(f);
    const entered = gate();
    const held = gate();
    const steps: string[] = [];
    vi.mocked(f.cm.writeFile).mockImplementation(async (_id, file, _content, options) => {
      expect(options).toBeUndefined();
      steps.push(`write:${file}`);
      if (file === '/fixture/a') {
        entered.release();
        await held.promise;
      }
    });
    vi.mocked(f.cm.execInContainer).mockImplementation(async (_id, cmd, options) => {
      expect(options).toEqual({ timeout: 5_000 });
      steps.push(`chmod:${cmd[2]}`);
      return { stdout: '', stderr: '', exitCode: 0 };
    });
    const pending = f.op.buildReviewerExecEnv(f.pod);
    try {
      await entered.promise;
      expect(steps).toEqual(['write:/fixture/a']);
    } finally {
      held.release();
      await pending;
    }
    expect(steps).toEqual([
      'write:/fixture/a',
      'write:/fixture/b',
      'write:/fixture/secret-a',
      'chmod:/fixture/secret-a',
      'write:/fixture/secret-b',
      'chmod:/fixture/secret-b',
    ]);
    f.reopen();
  });
  it.each([
    'target',
    'profile-after-recovery',
    'build',
    'first-write',
    'later-write',
    'chmod',
  ] as const)(
    '%s failure propagates by identity with original preceding effects',
    async (stage) => {
      const f = fixture();
      controlledBuild(f);
      const error = new Error(`Controlled ${stage}`);
      const writes: string[] = [];
      f.openai.mockResolvedValue();
      if (stage === 'target')
        f.get.mockImplementation(() => {
          throw error;
        });
      if (stage === 'profile-after-recovery')
        f.execution
          .mockImplementationOnce(() => f.profile)
          .mockImplementation(() => {
            throw error;
          });
      if (stage === 'build') f.build.mockRejectedValue(error);
      vi.mocked(f.cm.writeFile).mockImplementation(async (_id, file) => {
        if (
          (stage === 'first-write' && file === '/fixture/a') ||
          (stage === 'later-write' && file === '/fixture/b')
        )
          throw error;
        writes.push(file);
      });
      if (stage === 'chmod') vi.mocked(f.cm.execInContainer).mockRejectedValue(error);
      await expect(f.op.buildReviewerExecEnv(f.pod)).rejects.toBe(error);
      expect(f.warn).not.toHaveBeenCalled();
      expect(writes).toEqual(
        stage === 'later-write'
          ? ['/fixture/a']
          : stage === 'chmod'
            ? ['/fixture/a', '/fixture/b', '/fixture/secret-a']
            : [],
      );
      expect(f.reopen().attempts).toEqual([]);
    },
  );
  it.each(['max', 'openai', 'pi'] as const)(
    '%s recovery keeps an absent pod owner even when the profile has an account',
    async (provider) => {
      const f = fixture(provider);
      f.pod.providerAccountIdSnapshot = null;
      controlledBuild(f);
      const recovery = provider === 'max' ? f.max : provider === 'openai' ? f.openai : f.pi;
      recovery.mockResolvedValue();
      await f.op.buildReviewerExecEnv(f.pod);
      expect(recovery.mock.calls[0]?.at(-1)).toEqual({
        providerAccountStore: f.accounts,
        owner: undefined,
      });
      f.reopen();
    },
  );

  it('re-reads changed configuration after recovery without changing the initially selected recovery branch', async () => {
    const f = fixture();
    controlledBuild(f);
    const replacement = {
      ...f.profile,
      modelProvider: 'foundry' as const,
      defaultModel: 'new-model',
    };
    f.openai.mockImplementation(async () => {
      f.execution.mockReturnValue(replacement);
    });
    await f.op.buildReviewerExecEnv(f.pod);
    expect(f.openai).toHaveBeenCalledOnce();
    expect(f.max).not.toHaveBeenCalled();
    expect(f.pi).not.toHaveBeenCalled();
    expect(f.build.mock.calls[0]?.[0]).toEqual({ ...replacement, providerCredentials: f.initial });
    f.reopen();
  });

  it('real SQL credential update abort warns, retains old account auth and still builds/writes that auth', async () => {
    const f = fixture();
    vi.mocked(f.cm.readFile).mockResolvedValue('{"token":"unpersisted-rotation"}');
    f.db().exec(
      "CREATE TRIGGER reject_auth BEFORE UPDATE OF credentials ON provider_accounts WHEN OLD.id='selected' BEGIN SELECT RAISE(ABORT, 'auth update rejected'); END",
    );
    await expect(f.op.buildReviewerExecEnv(f.pod)).resolves.toMatchObject({ POD_ID: 'worker' });
    expect(f.warn).toHaveBeenCalledWith(
      {
        err: expect.objectContaining({ message: 'auth update rejected' }),
        podId: 'worker',
        provider: 'openai',
      },
      'Could not recover credentials from container before reviewer call',
    );
    expect(f.cm.writeFile).toHaveBeenCalledWith(
      'container',
      '/home/autopod/.codex/auth.json',
      '{"token":"fixture-old"}',
    );
    expect(f.reopen().accounts.get('selected').credentials).toEqual(f.initial);
  });
});
