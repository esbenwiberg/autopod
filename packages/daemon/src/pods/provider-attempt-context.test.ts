import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EffectiveLaunchConfig, Pod, ProviderFailoverTarget } from '@autopod/shared';
import { PROVIDER_CATALOG, PROVIDER_FAILOVER_HANDOFF_PATH } from '@autopod/shared';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveLaunchAgentRoute } from '../configuration/agent-route-resolution.js';
import { resolveLaunch } from '../configuration/launch-resolver.js';
import { createLaunchSnapshotRepository } from '../configuration/launch-snapshot.js';
import { loadOrCreateKey } from '../crypto/credentials-cipher.js';
import { createProfileStore } from '../profiles/index.js';
import { createProviderAccountStore } from '../provider-accounts/index.js';
import type { MaxCredentialLineage, ProviderEnvResult } from '../providers/types.js';
import { createTestConfiguration } from '../test-utils/configuration-helpers.js';
import { createTestDb, insertTestProfile } from '../test-utils/mock-helpers.js';
import { createPodRepository } from './pod-repository.js';
import {
  type ProviderAttemptCaptured,
  type ProviderAttemptLiveDependencies,
  createProviderAttemptContext,
} from './provider-attempt-context.js';
import {
  ProviderAttemptSupersededError,
  createProviderAttemptRepository,
} from './provider-attempt-repository.js';
const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});
function fixture(onDisk = false) {
  let db = createTestDb();
  insertTestProfile(db);
  let directory: string | undefined;
  let filename: string | undefined;
  if (onDisk) {
    directory = mkdtempSync(join(tmpdir(), 'provider-context-'));
    filename = join(directory, 'state.db');
    writeFileSync(filename, db.serialize());
    db.close();
    db = new Database(filename);
  }
  db.pragma('foreign_keys = ON');
  cleanups.push(() => {
    db.close();
    if (directory) rmSync(directory, { recursive: true, force: true });
  });
  const cipher = directory ? loadOrCreateKey(join(directory, 'test.key')) : undefined;
  const podRepo = createPodRepository(db);
  podRepo.insert({
    id: 'context',
    profileName: 'test-profile',
    task: 'Task',
    status: 'running',
    runtime: 'claude',
    model: 'opus',
    executionTarget: 'local',
    branch: 'branch',
    userId: 'operator',
    maxValidationAttempts: 3,
    skipValidation: false,
    outputMode: 'pr',
  });
  const accounts = createProviderAccountStore(db, cipher);
  accounts.create({
    id: 'account',
    name: 'Main',
    provider: 'anthropic',
    credentials: { provider: 'anthropic', apiKey: 'synthetic-main' },
  });
  accounts.create({
    id: 'backup',
    name: 'Backup',
    provider: 'openai',
    credentials: { provider: 'openai', authJson: '{"OPENAI_API_KEY":"synthetic-backup"}' },
  });
  const profiles = createProfileStore(db);
  const repo = createProviderAttemptRepository(db);
  const activeAgentRuns = new Map<
    string,
    { token: symbol; providerOrdinal?: number; isCurrent?: () => boolean }
  >();
  const live: ProviderAttemptLiveDependencies = { providerAttemptRepo: repo };
  const captured: ProviderAttemptCaptured = {
    podRepo,
    providerAccountStore: accounts,
    providerCatalog: PROVIDER_CATALOG,
    profileStore: profiles,
    executionForPod: () => profiles.get('test-profile'),
    activeAgentRuns,
  };
  const context = createProviderAttemptContext(live, captured);
  return {
    get db() {
      return db;
    },
    podRepo,
    accounts,
    profiles,
    repo,
    live,
    captured,
    context,
    activeAgentRuns,
    pod: () => podRepo.getOrThrow('context'),
    profile: () => profiles.get('test-profile'),
    reopen() {
      if (!filename) throw new Error('Expected private file fixture');
      db.close();
      db = new Database(filename);
      db.pragma('foreign_keys = ON');
      expect(db.pragma('integrity_check', { simple: true })).toBe('ok');
      expect(db.pragma('foreign_key_check')).toEqual([]);
      return {
        repo: createProviderAttemptRepository(db),
        accounts: createProviderAccountStore(db, cipher),
        profiles: createProfileStore(db),
        pods: createPodRepository(db),
      };
    },
  };
}
const target: ProviderFailoverTarget = {
  providerAccountId: 'backup',
  runtime: 'codex',
  model: 'gpt-5',
};
describe('provider attempt context', () => {
  it('constructs without service calls and captures exactly the original collaborator references', () => {
    const f = fixture();
    const get = vi.spyOn(f.accounts, 'get');
    const resolve = vi.spyOn(f.profiles, 'resolveProviderFailover');
    const active = vi.spyOn(f.repo, 'getActive');
    const execution = vi.fn(f.captured.executionForPod);
    const c = createProviderAttemptContext(f.live, { ...f.captured, executionForPod: execution });
    expect(get).not.toHaveBeenCalled();
    expect(resolve).not.toHaveBeenCalled();
    expect(active).not.toHaveBeenCalled();
    expect(execution).not.toHaveBeenCalled();
    f.captured.providerAccountStore = undefined;
    expect(
      c.providerForAttempt({ ...f.pod(), providerAccountIdSnapshot: 'backup' }, f.profile()),
    ).toBe('openai');
    expect(get).toHaveBeenCalledWith('backup');
  });
  it('keeps snapshot/account/profile/runtime provider precedence and catches legacy lookup failures', () => {
    const f = fixture();
    const p = f.pod();
    const profile = f.profile();
    expect(
      f.context.providerForAttempt(
        { ...p, providerIdSnapshot: 'max', providerAccountIdSnapshot: 'backup' },
        profile,
      ),
    ).toBe('max');
    expect(
      f.context.providerForAttempt({ ...p, providerAccountIdSnapshot: 'backup' }, profile),
    ).toBe('openai');
    expect(
      f.context.providerForAttempt(
        { ...p, providerAccountIdSnapshot: 'deleted' },
        { ...profile, modelProvider: 'openrouter' },
      ),
    ).toBe('openrouter');
    for (const runtime of ['claude', 'codex', 'copilot', 'pi'] as const)
      expect(
        f.context.providerForAttempt({ ...p, runtime }, { ...profile, modelProvider: null }),
      ).toBe(runtime === 'claude' ? 'anthropic' : runtime === 'codex' ? 'openai' : runtime);
  });
  it('retains active redacted snapshot identity and rejects requireNew or mismatched identities', () => {
    const f = fixture();
    const profile = f.profile();
    const p = f.pod();
    const first = f.context.ensureProviderAttempt(p, profile);
    expect(first).toMatchObject({ ordinal: 1, providerAccountId: null });
    const snapshot = f.repo.getActiveProfileSnapshot(p.id);
    expect(
      f.context.ensureProviderAttempt(p, { ...profile, customInstructions: 'later defaults' }),
    ).toEqual(first);
    expect(f.repo.getActiveProfileSnapshot(p.id)).toEqual(snapshot);
    expect(() => f.context.ensureProviderAttempt(p, profile, true)).toThrow(
      ProviderAttemptSupersededError,
    );
    expect(() => f.context.ensureProviderAttempt({ ...p, model: 'different' }, profile)).toThrow(
      /identity mismatch/,
    );
    expect(f.repo.list(p.id)).toHaveLength(1);
  });
  it('reads late repository replacements and their methods with the original receiver', () => {
    const f = fixture();
    f.live.providerAttemptRepo = undefined;
    expect(f.context.ensureProviderAttempt(f.pod(), f.profile())).toBeNull();
    expect(() => f.context.openProviderTargetAttempt(f.pod(), target)).toThrow(
      /repository is unavailable/,
    );
    const replacement = createProviderAttemptRepository(f.db);
    const calls: unknown[] = [];
    const original = replacement.getActive;
    replacement.getActive = function (id) {
      calls.push(this);
      return original(id);
    };
    f.live.providerAttemptRepo = replacement;
    expect(f.context.ensureProviderAttempt(f.pod(), f.profile())).toMatchObject({ ordinal: 1 });
    expect(calls).toEqual([replacement]);
    expect(f.repo.list(f.pod().id)).toHaveLength(1);
  });
  it.each(['wrong-token', 'not-current', 'wrong-ordinal'] as const)(
    'fences rotation by %s before any history write',
    (mode) => {
      const f = fixture();
      const token = Symbol('owner');
      const first = f.context.ensureProviderAttempt(f.pod(), f.profile());
      f.activeAgentRuns.set('context', {
        token: mode === 'wrong-token' ? Symbol('other') : token,
        providerOrdinal: mode === 'wrong-ordinal' ? 99 : first?.ordinal,
        isCurrent: () => mode !== 'not-current',
      });
      const before = f.repo.listRaw('context');
      expect(() =>
        f.context.rotateProviderAttemptForFreshSegment(f.pod(), f.profile(), true, token),
      ).toThrow(ProviderAttemptSupersededError);
      expect(f.repo.listRaw('context')).toEqual(before);
    },
  );
  it('rotates by closing the old segment first and updates the same run owner object', () => {
    const f = fixture();
    const token = Symbol('owner');
    const first = f.context.ensureProviderAttempt(f.pod(), f.profile());
    f.repo.updateActive('context', {
      nativeSessionId: 'session',
      inputTokens: 7,
      outputTokens: 3,
      costUsd: 0.2,
    });
    const owner = { token, providerOrdinal: first?.ordinal, isCurrent: () => true };
    f.activeAgentRuns.set('context', owner);
    expect(f.context.rotateProviderAttemptForFreshSegment(f.pod(), f.profile(), true, token)).toBe(
      true,
    );
    expect(f.activeAgentRuns.get('context')).toBe(owner);
    expect(owner.providerOrdinal).toBe(2);
    expect(f.repo.list('context')).toMatchObject([
      {
        ordinal: 1,
        outcome: 'aborted',
        nativeSessionId: 'session',
        inputTokens: 7,
        outputTokens: 3,
        costUsd: 0.2,
      },
      { ordinal: 2, outcome: null },
    ]);
  });
  it('leaves a fresh failover handoff continuation and absent/prior-attempt noops intact', () => {
    const f = fixture();
    expect(f.context.rotateProviderAttemptForFreshSegment(f.pod(), f.profile(), true)).toBe(false);
    f.context.ensureProviderAttempt(f.pod(), f.profile());
    expect(f.context.rotateProviderAttemptForFreshSegment(f.pod(), f.profile(), false)).toBe(false);
    f.context.closeProviderAttempt(
      'context',
      'quota_exhausted',
      null,
      PROVIDER_FAILOVER_HANDOFF_PATH,
    );
    f.context.ensureProviderAttempt(f.pod(), f.profile(), true);
    const before = f.repo.listRaw('context');
    expect(f.context.rotateProviderAttemptForFreshSegment(f.pod(), f.profile(), true)).toBe(false);
    expect(f.repo.listRaw('context')).toEqual(before);
  });
  it('preserves exact MAX lineage references, cleanup and per-manager collection ownership', () => {
    const f = fixture();
    const other = createProviderAttemptContext(f.live, f.captured);
    const lineage: MaxCredentialLineage = {
      owner: { type: 'provider-account', id: 'account' },
      issuedRefreshToken: 'synthetic-refresh',
    };
    const result: ProviderEnvResult = {
      env: {},
      containerFiles: [],
      secretFiles: [],
      requiresPostExecPersistence: false,
      maxCredentialLineage: lineage,
    };
    f.context.rememberMaxCredentialLineage('context', result);
    expect(f.context.maxCredentialLineageByPod.get('context')).toBe(lineage);
    expect(other.maxCredentialLineageByPod.size).toBe(0);
    f.context.rememberMaxCredentialLineage('context', {
      ...result,
      maxCredentialLineage: undefined,
    });
    expect(f.context.maxCredentialLineageByPod.size).toBe(0);
    f.context.rememberMaxCredentialLineage('context', result);
    f.context.forgetMaxCredentialLineage('context');
    expect(f.context.maxCredentialLineageByPod.size).toBe(0);
  });
  it.each([
    {
      provider: 'max',
      credentials: { provider: 'max', oauthToken: 'synthetic' },
      runtime: 'claude',
    },
    {
      provider: 'openrouter',
      credentials: { provider: 'openrouter', apiKey: 'synthetic' },
      runtime: 'codex',
    },
    {
      provider: 'copilot',
      credentials: { provider: 'copilot', token: 'synthetic' },
      runtime: 'copilot',
    },
    {
      provider: 'pi',
      credentials: {
        provider: 'pi',
        providerId: 'anthropic',
        credential: { accessToken: 'synthetic' },
      },
      runtime: 'pi',
    },
    {
      provider: 'foundry',
      credentials: {
        provider: 'foundry',
        endpoint: 'https://example.services.ai.azure.com',
        apiKey: 'synthetic',
        apiSurface: 'openai',
      },
      runtime: 'codex',
    },
    {
      provider: 'foundry',
      credentials: {
        provider: 'foundry',
        endpoint: 'https://example.services.ai.azure.com',
        apiKey: 'synthetic',
        apiSurface: 'anthropic',
      },
      runtime: 'claude',
    },
  ] as const)('retains $provider/$runtime runtime compatibility', (input) => {
    const f = fixture();
    const account = f.accounts.create({
      id: 'candidate',
      name: 'Candidate',
      provider: input.provider,
      credentials: input.credentials,
    });
    for (const runtime of ['claude', 'codex', 'copilot', 'pi'] as const)
      expect(
        f.context.isCompatibleTarget(
          { ...target, providerAccountId: account.id, runtime },
          account,
        ),
      ).toBe(runtime === input.runtime);
    expect(
      f.context.isCompatibleTarget(
        { ...target, runtime: input.runtime },
        { ...account, credentials: null },
      ),
    ).toBe(false);
  });
  it('honors inherited account policy, configured order, used targets and hop limits', () => {
    const f = fixture();
    f.profiles.update('test-profile', { providerAccountId: 'account' });
    f.accounts.update('account', { failoverPolicy: { targets: [target], maxHops: 1 } });
    expect(f.profiles.resolveProviderFailover('test-profile').source).toBe('account-default');
    expect(f.context.selectProviderFailoverTarget(f.pod())).toEqual({ target, reason: null });
    f.context.openProviderTargetAttempt(f.pod(), target);
    expect(f.context.selectProviderFailoverTarget(f.pod())).toEqual({
      target: null,
      reason: { type: 'exhausted', attemptedTargets: [target], hopsUsed: 1, maxHops: 1 },
    });
  });
  it('distinguishes absent infrastructure, no policy, disabled policy and ineligible targets', () => {
    const f = fixture();
    expect(f.context.selectProviderFailoverTarget(f.pod())).toEqual({
      target: null,
      reason: { type: 'no_policy' },
    });
    f.profiles.update('test-profile', { providerFailover: { targets: [] } });
    expect(f.context.selectProviderFailoverTarget(f.pod())).toEqual({
      target: null,
      reason: { type: 'disabled' },
    });
    f.profiles.update('test-profile', { providerFailover: { targets: [target] } });
    f.accounts.updateCredentials('backup', null);
    expect(f.context.selectProviderFailoverTarget(f.pod())).toEqual({
      target: null,
      reason: { type: 'ineligible', targets: [target] },
    });
    f.live.providerAttemptRepo = undefined;
    expect(f.context.selectProviderFailoverTarget(f.pod())).toEqual({
      target: null,
      reason: { type: 'unavailable' },
    });
  });
  it('skips deleted and incompatible targets in configured order', () => {
    const f = fixture();
    const bad = { ...target, providerAccountId: 'account' };
    f.profiles.update('test-profile', { providerFailover: { targets: [bad, target] } });
    expect(f.context.selectProviderFailoverTarget(f.pod()).target).toEqual(target);
    const get = f.accounts.get;
    vi.spyOn(f.accounts, 'get').mockImplementation((id) => {
      if (id === 'backup') throw new Error('Historical target no longer available');
      return get(id);
    });
    expect(f.context.selectProviderFailoverTarget(f.pod())).toEqual({
      target: null,
      reason: { type: 'ineligible', targets: [bad, target] },
    });
  });
  it('keeps bounded escaped diagnostics and every typed reason message', () => {
    const c = fixture().context;
    expect(c.escapeProviderTargetDiagnosticValue('  ', 'missing')).toBe('missing');
    expect(c.escapeProviderTargetDiagnosticValue(' x\n[💡] ', 'missing')).toBe(
      'x\\u{a}\\u{5b}\\u{1f4a1}\\u{5d}',
    );
    expect(c.escapeProviderTargetDiagnosticValue('a'.repeat(300), '')).toHaveLength(256);
    expect(c.describeProviderFailoverTarget(target)).toBe(
      'account=backup runtime=codex model=gpt-5',
    );
    expect(
      c.providerFailoverUnavailableActivity({ target: null, reason: { type: 'no_policy' } }),
    ).toBe('Provider limit reached — automatic failover has no configured policy');
    expect(
      c.providerFailoverUnavailableActivity({ target: null, reason: { type: 'disabled' } }),
    ).toContain('explicitly disabled');
    expect(
      c.providerFailoverUnavailableActivity({ target: null, reason: { type: 'unavailable' } }),
    ).toContain('infrastructure is unavailable');
    expect(
      c.providerFailoverUnavailableActivity({
        target: null,
        reason: { type: 'ineligible', targets: [target] },
      }),
    ).toContain('ineligible: account=backup runtime=codex model=gpt-5');
    expect(
      c.providerFailoverUnavailableActivity({
        target: null,
        reason: { type: 'exhausted', attemptedTargets: [target], hopsUsed: 1, maxHops: 2 },
      }),
    ).toContain('1/2 hops used');
    expect(() => c.providerFailoverUnavailableActivity({ target, reason: null })).toThrow(
      /does not need a diagnostic/,
    );
  });
  it('resolves queued snapshot bindings before mutable defaults and rejects missing account identity', () => {
    const f = fixture();
    const p: Pod = {
      ...f.pod(),
      providerAccountIdSnapshot: 'backup',
      providerIdSnapshot: 'openai',
      runtime: 'codex',
      model: 'saved-model',
    };
    expect(f.context.resolveEffectiveBoundProfile(p)).toMatchObject({
      providerAccountId: 'backup',
      modelProvider: 'openai',
      defaultRuntime: 'codex',
      defaultModel: 'saved-model',
    });
    expect(() =>
      f.context.resolveEffectiveBoundProfile({ ...p, providerIdSnapshot: 'anthropic' }),
    ).toThrow(expect.objectContaining({ code: 'INVALID_PROVIDER_TARGET' }));
    f.accounts.delete('backup');
    expect(() => f.context.resolveEffectiveBoundProfile(p)).toThrow(
      expect.objectContaining({ code: 'INVALID_PROVIDER_TARGET' }),
    );
  });
  it('uses active/latest attempt bindings and rejects contradictory history or unreconciled legacy rows', () => {
    const f = fixture();
    expect(f.context.resolveEffectiveBoundProfile(f.pod())).toEqual(f.profile());
    f.context.openProviderTargetAttempt(f.pod(), target);
    const bound = {
      ...f.pod(),
      runtime: target.runtime,
      model: target.model,
      providerAccountIdSnapshot: 'backup',
      providerIdSnapshot: 'openai' as const,
    };
    expect(f.context.resolveEffectiveBoundProfile(bound)).toMatchObject({
      providerAccountId: 'backup',
    });
    expect(() => f.context.resolveEffectiveBoundProfile(f.pod())).toThrow(/identity mismatch/);
    f.context.closeProviderAttempt('context', 'completed');
    expect(f.context.resolveEffectiveBoundProfile(bound)).toMatchObject({ defaultModel: 'gpt-5' });
    expect(() => f.context.resolveEffectiveBoundProfile(f.pod())).toThrow(
      expect.objectContaining({ code: 'INVALID_PROVIDER_TARGET' }),
    );
  });
  it('checks real saved launch routes and immutable account identity through late launch reads', async () => {
    const f = fixture();
    const { services, store } = createTestConfiguration(f.db);
    services.resolveAgentRoute = async (route) => resolveLaunchAgentRoute(route, f.accounts);
    const launch = await resolveLaunch({ repositoryId: 'repo-a', task: 'Saved launch' }, services);
    const snapshots = createLaunchSnapshotRepository(f.db, store);
    snapshots.admit({ config: launch, requestDigest: 'fixture', createPod: () => 'context' });
    f.live.launchConfiguration = { read: snapshots.get };
    const bound: Pod = {
      ...f.pod(),
      providerAccountIdSnapshot: 'account',
      providerIdSnapshot: 'anthropic',
      runtime: 'claude',
      model: launch.ai.main.model,
    };
    expect(f.context.resolveEffectiveBoundProfile(bound)).toMatchObject({
      providerAccountId: 'account',
      defaultModel: launch.ai.main.model,
    });
    expect(() =>
      f.context.resolveEffectiveBoundProfile({ ...bound, model: 'outside-route' }),
    ).toThrow(expect.objectContaining({ code: 'PROVIDER_BINDING_MISMATCH' }));
    const savedAccount = launch.agentAccounts.account;
    if (!savedAccount) throw new Error('Missing saved account fixture');
    const changed: EffectiveLaunchConfig = {
      ...launch,
      agentAccounts: {
        ...launch.agentAccounts,
        account: { ...savedAccount, createdAt: '1900-01-01T00:00:00Z' },
      },
    };
    f.live.launchConfiguration = { read: () => changed };
    expect(() => f.context.resolveEffectiveBoundProfile(bound)).toThrow(
      expect.objectContaining({ code: 'PROVIDER_BINDING_MISMATCH' }),
    );
  });
  it.each(['legacy-close', 'target-snapshot', 'stale-rotation'] as const)(
    'persists %s through a private encrypted SQLite close/reopen',
    (scenario) => {
      const f = fixture(true);
      const p = f.pod();
      const profile = f.profile();
      const accountBefore = f.accounts.list();
      const profileBefore = f.profile();
      if (scenario === 'legacy-close') {
        f.context.ensureProviderAttempt(
          { ...p, inputTokens: 20, outputTokens: 5, costUsd: 0.4, claudeSessionId: 'legacy' },
          profile,
        );
        f.repo.updateActive(p.id, {
          nativeSessionId: 'new',
          inputTokens: 3,
          outputTokens: 2,
          costUsd: 0.1,
        });
        f.podRepo.update(p.id, { claudeSessionId: 'new' });
        f.context.closeProviderAttempt(p.id, 'completed', null, null, 2);
        expect(f.repo.listRaw(p.id)).toMatchObject([
          { ordinal: 1, outcome: 'completed', inputTokens: 20, nativeSessionId: 'legacy' },
          { ordinal: 2, outcome: 'completed', inputTokens: 3, nativeSessionId: 'new' },
        ]);
        expect(f.repo.totals(p.id)).toEqual({ inputTokens: 23, outputTokens: 7, costUsd: 0.5 });
      } else if (scenario === 'target-snapshot') {
        f.podRepo.update(p.id, { profileSnapshot: { ...profile, reasoningEffort: 'xhigh' } });
        f.context.openProviderTargetAttempt(f.pod(), target);
        expect(f.repo.getActive(p.id)).toMatchObject({
          ordinal: 1,
          provider: 'openai',
          runtime: 'codex',
          model: 'gpt-5',
          providerAccountId: 'backup',
        });
        expect(f.repo.getActiveProfileSnapshot(p.id)).toMatchObject({
          reasoningEffort: 'xhigh',
          providerCredentials: null,
          defaultRuntime: 'codex',
          defaultModel: 'gpt-5',
        });
      } else {
        f.context.ensureProviderAttempt(p, profile);
        f.context.rotateProviderAttemptForFreshSegment(p, profile, true);
        const before = f.repo.listRaw(p.id);
        expect(() => f.context.closeProviderAttempt(p.id, 'failed', null, null, 1)).toThrow(
          ProviderAttemptSupersededError,
        );
        expect(f.repo.listRaw(p.id)).toEqual(before);
      }
      const history = f.repo.listRaw(p.id);
      const activeSnapshot = f.repo.getActiveProfileSnapshot(p.id);
      const totals = f.repo.totals(p.id);
      const rawAccounts = f.db.prepare('SELECT * FROM provider_accounts ORDER BY id').all();
      expect(JSON.stringify(rawAccounts)).not.toContain('synthetic-main');
      const reopened = f.reopen();
      expect(reopened.repo.listRaw(p.id)).toEqual(history);
      expect(reopened.repo.totals(p.id)).toEqual(totals);
      expect(reopened.repo.getActiveProfileSnapshot(p.id)).toEqual(activeSnapshot);
      expect(reopened.accounts.list()).toEqual(accountBefore);
      expect(reopened.profiles.get('test-profile')).toEqual(profileBefore);
      expect(f.db.prepare('SELECT * FROM provider_accounts ORDER BY id').all()).toEqual(
        rawAccounts,
      );
      if (scenario === 'stale-rotation') {
        const live = { providerAttemptRepo: reopened.repo };
        const c = createProviderAttemptContext(live, {
          ...f.captured,
          podRepo: reopened.pods,
          providerAccountStore: reopened.accounts,
          profileStore: reopened.profiles,
          executionForPod: () => reopened.profiles.get('test-profile'),
        });
        expect(() => c.closeProviderAttempt(p.id, 'failed', null, null, 1)).toThrow(
          ProviderAttemptSupersededError,
        );
        expect(reopened.repo.listRaw(p.id)).toEqual(history);
      }
    },
  );
});
