import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProviderFailureClassification } from '@autopod/shared';
import { PROVIDER_FAILOVER_HANDOFF_PATH } from '@autopod/shared';
import Database from 'better-sqlite3';
import pino from 'pino';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createProfileStore } from '../profiles/index.js';
import { createProviderAccountStore } from '../provider-accounts/index.js';
import {
  createMockContainerManager,
  createMockRuntime,
  createMockRuntimeRegistry,
  createMockWorktreeManager,
  createTestDb,
  insertTestProfile,
} from '../test-utils/mock-helpers.js';
import type { ContinuationCaptured, ContinuationLiveDependencies } from './continuation-ports.js';
import { createEventRepository } from './event-repository.js';
import { createPodRepository } from './pod-repository.js';
import { createProviderAttemptContext } from './provider-attempt-context.js';
import { createProviderAttemptRepository } from './provider-attempt-repository.js';
import { createProviderContinuation } from './provider-continuation.js';
const cleanups: Array<() => void> = [];
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const close of cleanups.splice(0).reverse()) close();
});
const classification: ProviderFailureClassification = {
  category: 'quota_exhausted',
  definitive: true,
  sanitizedMessage: 'Synthetic quota exhausted',
};
const target = { providerAccountId: 'backup', runtime: 'codex' as const, model: 'gpt-5' };
function fixture(disk = false) {
  let db = createTestDb();
  insertTestProfile(db);
  const directory = mkdtempSync(join(tmpdir(), 'provider-continuation-'));
  const filename = join(directory, 'state.db');
  if (disk) {
    writeFileSync(filename, db.serialize());
    db.close();
    db = new Database(filename);
    db.pragma('foreign_keys=ON');
  }
  cleanups.push(() => {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const podRepo = createPodRepository(db);
  const profiles = createProfileStore(db);
  const repo = createProviderAttemptRepository(db);
  const accounts = createProviderAccountStore(db);
  accounts.create({
    id: 'account',
    name: 'Main',
    provider: 'anthropic',
    credentials: { provider: 'anthropic', apiKey: 'synthetic' },
  });
  accounts.create({
    id: 'backup',
    name: 'Backup',
    provider: 'openai',
    credentials: { provider: 'openai', authJson: '{"OPENAI_API_KEY":"synthetic"}' },
  });
  profiles.update('test-profile', {
    providerAccountId: 'account',
    providerFailover: { targets: [target] },
  });
  podRepo.insert({
    id: 'continuation',
    profileName: 'test-profile',
    task: 'Original',
    status: 'paused',
    runtime: 'claude',
    model: 'opus',
    executionTarget: 'local',
    branch: 'branch',
    userId: 'operator',
    maxValidationAttempts: 3,
    skipValidation: false,
    outputMode: 'pr',
    providerAccountIdSnapshot: 'account',
    providerIdSnapshot: 'anthropic',
  });
  podRepo.update('continuation', {
    worktreePath: directory,
    containerId: 'container',
    pauseReason: 'provider_limit',
    claudeSessionId: 'source-session',
  });
  const events = createEventRepository(db);
  const runtime = createMockRuntime();
  const cm = createMockContainerManager();
  const order: string[] = [];
  const live: ContinuationLiveDependencies = { providerAttemptRepo: repo, eventRepo: events };
  const attempts = createProviderAttemptContext(
    { providerAttemptRepo: repo },
    {
      podRepo,
      providerAccountStore: accounts,
      profileStore: profiles,
      executionForPod: () => profiles.get('test-profile'),
      activeAgentRuns: new Map(),
    },
  );
  attempts.ensureProviderAttempt(podRepo.getOrThrow('continuation'), profiles.get('test-profile'));
  repo.updateActive('continuation', {
    inputTokens: 10,
    outputTokens: 2,
    costUsd: 0.3,
    nativeSessionId: 'source-session',
  });
  attempts.closeProviderAttempt(
    'continuation',
    'quota_exhausted',
    classification,
    PROVIDER_FAILOVER_HANDOFF_PATH,
  );
  const captured = {
    ...attempts,
    podRepo,
    profileStore: profiles,
    providerAccountStore: accounts,
    containerManagerFactory: { get: vi.fn(() => cm) },
    worktreeManager: {
      ...createMockWorktreeManager(),
      ensureExcludes: vi.fn(async (_worktree: string, _paths: string[]) => {}),
    },
    runtimeRegistry: createMockRuntimeRegistry(runtime),
    enqueueSession: vi.fn(() => order.push('enqueue')),
    logger: pino({ enabled: false }),
    executionForPod: () => profiles.get('test-profile'),
    assertExecutionTerminationVerified: vi.fn(),
    stopHaproxyDenyReceiver: vi.fn(async () => {
      order.push('deny-stop');
    }),
    CONTAINER_CLEANUP_TIMEOUT_MS: 15_000,
    stopSandboxPreviewProxy: vi.fn(async () => {
      order.push('preview-stop');
    }),
    syncWorkspaceBack: vi.fn(async () => {
      order.push('sync');
      return { pushed: false };
    }),
    emitActivityStatus: vi.fn((_id, message) => order.push(message)),
    operatorErrorMessage: (error: unknown) => String(error),
    transition: vi.fn<ContinuationCaptured['transition']>((pod, status, extra) => {
      podRepo.update(pod.id, { ...extra, status });
      return podRepo.getOrThrow(pod.id);
    }),
  };
  const c = createProviderContinuation(live, captured);
  return {
    get db() {
      return db;
    },
    directory,
    filename,
    podRepo,
    profiles,
    repo,
    accounts,
    events,
    runtime,
    cm,
    live,
    captured,
    attempts,
    c,
    order,
    pod: () => podRepo.getOrThrow('continuation'),
    reopen() {
      db.close();
      db = new Database(filename);
      db.pragma('foreign_keys=ON');
      return {
        pods: createPodRepository(db),
        repo: createProviderAttemptRepository(db),
        accounts: createProviderAccountStore(db),
        profiles: createProfileStore(db),
      };
    },
  };
}
describe('provider continuation', () => {
  it('reads late event services and projects only selected visible status/tool events', () => {
    const f = fixture();
    f.live.eventRepo = undefined;
    expect(f.c.visibleProviderHandoffActivity('continuation')).toEqual([]);
    f.events.insert({
      type: 'pod.agent_activity',
      timestamp: '2026-10-18',
      podId: 'continuation',
      event: { type: 'status', message: 'Visible status', timestamp: '2026-10-18' },
    });
    f.events.insert({
      type: 'pod.agent_activity',
      timestamp: '2026-10-18',
      podId: 'continuation',
      event: {
        type: 'tool_use',
        tool: 'read',
        input: {},
        output: 'Visible outcome',
        timestamp: '2026-10-18',
      },
    });
    f.live.eventRepo = f.events;
    expect(f.c.visibleProviderHandoffActivity('continuation')).toEqual([
      'Status: Visible status',
      'Tool outcome (read) — Visible outcome',
    ]);
  });
  it('protects exclusions before writing a real bounded handoff in a private Git worktree', async () => {
    const f = fixture();
    execFileSync('git', ['init', '-q', f.directory]);
    vi.mocked(f.captured.worktreeManager.ensureExcludes).mockImplementation(
      async (worktree, paths) => {
        expect(() => readFileSync(join(worktree, PROVIDER_FAILOVER_HANDOFF_PATH))).toThrow();
        writeFileSync(join(worktree, '.git/info/exclude'), paths.join('\n'));
      },
    );
    await f.c.prepareProviderContinuationHandoff(f.pod(), classification);
    const content = readFileSync(join(f.directory, PROVIDER_FAILOVER_HANDOFF_PATH), 'utf8');
    expect(content).toContain('# Autopod provider failover handoff');
    expect(content).toContain('Original');
    expect(content).toContain('Synthetic quota exhausted');
    expect(content.length).toBeLessThanOrEqual(30_000);
    expect(
      execFileSync('git', ['check-ignore', PROVIDER_FAILOVER_HANDOFF_PATH], {
        cwd: f.directory,
        encoding: 'utf8',
      }).trim(),
    ).toBe(PROVIDER_FAILOVER_HANDOFF_PATH);
  });
  it.each([false, true])(
    'queues alternate bindings with defer=%s and clears old native sessions',
    async (defer) => {
      const f = fixture();
      const requeue = vi.fn(() => f.order.push('deferred'));
      f.live.requeueSessionAfterCurrent = requeue;
      await f.c.queueProviderContinuation(f.pod(), target, classification, defer, true);
      expect(f.pod()).toMatchObject({
        status: 'queued',
        runtime: 'codex',
        model: 'gpt-5',
        providerAccountIdSnapshot: 'backup',
        providerIdSnapshot: 'openai',
        containerId: null,
        recoveryWorktreePath: f.directory,
        pauseReason: null,
        claudeSessionId: null,
      });
      expect(f.repo.getActive('continuation')).toMatchObject({
        ordinal: 2,
        providerAccountId: 'backup',
      });
      expect(f.order[0]).toBe(defer ? 'deferred' : 'enqueue');
      expect(f.order[1]).toBe('Provider continuation queued: codex/gpt-5');
    },
  );
  it('preserves a native session for the exact same source account/runtime/model', async () => {
    const f = fixture();
    await f.c.queueProviderContinuation(
      f.pod(),
      { providerAccountId: 'account', runtime: 'claude', model: 'opus' },
      classification,
      false,
      true,
    );
    expect(f.pod().claudeSessionId).toBe('source-session');
  });
  it('closes an opened replacement aborted and restores all binding fields on transition failure', async () => {
    const f = fixture();
    const before = f.pod();
    const error = new Error('Transition failure');
    f.captured.transition.mockImplementationOnce(() => {
      throw error;
    });
    await expect(
      f.c.queueProviderContinuation(before, target, classification, false, true),
    ).rejects.toBe(error);
    expect(f.pod()).toMatchObject({
      runtime: before.runtime,
      model: before.model,
      providerAccountIdSnapshot: before.providerAccountIdSnapshot,
      containerId: before.containerId,
      recoveryWorktreePath: before.recoveryWorktreePath,
      pauseReason: before.pauseReason,
      claudeSessionId: before.claudeSessionId,
    });
    expect(f.repo.list('continuation')).toMatchObject([
      { ordinal: 1, outcome: 'quota_exhausted' },
      { ordinal: 2, outcome: 'aborted' },
    ]);
    expect(f.captured.enqueueSession).not.toHaveBeenCalled();
  });
  it.each(['abort', 'sync', 'kill', 'timeout'] as const)(
    'fails closed during automatic %s drain and cleans timers',
    async (stage) => {
      const f = fixture();
      const error = new Error('Controlled drain failure');
      if (stage === 'abort') vi.mocked(f.runtime.abort).mockRejectedValueOnce(error);
      if (stage === 'sync') f.captured.syncWorkspaceBack.mockRejectedValueOnce(error);
      if (stage === 'kill') vi.mocked(f.cm.kill).mockRejectedValueOnce(error);
      if (stage === 'timeout') {
        vi.useFakeTimers();
        vi.mocked(f.cm.kill).mockReturnValueOnce(new Promise<void>(() => {}));
      }
      const before = f.repo.listRaw('continuation');
      const operation = f.c.handleProviderLimit('continuation', classification);
      if (stage === 'timeout') await vi.advanceTimersByTimeAsync(15_001);
      await operation;
      expect(f.repo.listRaw('continuation')).toEqual(before);
      expect(f.pod().containerId).toBe('container');
      expect(f.captured.enqueueSession).not.toHaveBeenCalled();
      if (stage === 'timeout') expect(vi.getTimerCount()).toBe(0);
    },
  );
  it('drains and forgets lineage before protecting and queueing an automatic target', async () => {
    const f = fixture();
    vi.mocked(f.runtime.abort).mockImplementationOnce(async () => {
      f.order.push('abort');
    });
    vi.mocked(f.cm.kill).mockImplementationOnce(async () => {
      f.order.push('kill');
    });
    await f.c.handleProviderLimit('continuation', classification);
    expect(f.order.slice(0, 5)).toEqual(['abort', 'sync', 'preview-stop', 'deny-stop', 'kill']);
    expect(f.pod()).toMatchObject({ status: 'queued', containerId: null });
    expect(f.captured.enqueueSession).toHaveBeenCalledOnce();
  });
  it.each(['same', 'alternate', 'primary'] as const)(
    'returns the original explicit %s continuation action',
    async (mode) => {
      const f = fixture();
      if (mode === 'primary') f.podRepo.update('continuation', { status: 'failed' });
      const result = await f.c.continueProvider(
        'continuation',
        mode === 'primary' ? 'profile-primary' : mode === 'alternate' ? target : undefined,
      );
      expect(result.action).toBe(
        mode === 'primary'
          ? 'primary-provider'
          : mode === 'alternate'
            ? 'alternate-provider'
            : 'same-provider',
      );
      expect(f.pod().status).toBe('queued');
    },
  );
  it('rejects unsupported state and missing definitive evidence without changing retained source', async () => {
    const f = fixture();
    const before = f.pod();
    await expect(f.c.continueProvider('continuation', 'profile-primary')).rejects.toMatchObject({
      code: 'INVALID_STATE',
    });
    expect(f.pod()).toEqual(before);
    f.podRepo.update('continuation', { worktreeCompromised: true });
    await expect(f.c.continueProvider('continuation')).rejects.toMatchObject({
      code: 'WORKTREE_COMPROMISED',
    });
  });
  it.each(['worker', 'evidence', 'policy', 'same-hop'] as const)(
    'retains source before explicit %s guard denial',
    async (reason) => {
      const f = fixture();
      let c = f.c;
      let requested: typeof target | undefined;
      let code = 'INVALID_PROVIDER_TARGET';
      if (reason === 'worker') {
        const executions = f.podRepo.taskExecutions;
        if (!executions) throw new Error('Missing task ledger fixture');
        vi.spyOn(executions, 'hasActiveRun').mockReturnValue(true);
        code = 'TASK_AGENT_RUN_ACTIVE';
      } else if (reason === 'evidence') {
        c = createProviderContinuation(
          { ...f.live, providerAttemptRepo: { list: () => [] } },
          f.captured,
        );
        code = 'PROVIDER_LIMIT_NOT_DEFINITIVE';
      } else if (reason === 'policy') {
        requested = { ...target, model: 'unconfigured-model' };
      } else {
        f.attempts.ensureProviderAttempt(f.pod(), f.profiles.get('test-profile'));
        f.attempts.closeProviderAttempt(
          'continuation',
          'quota_exhausted',
          classification,
          PROVIDER_FAILOVER_HANDOFF_PATH,
        );
        code = 'PROVIDER_FAILOVER_HOP_LIMIT';
      }
      const before = f.pod();
      const history = f.repo.listRaw('continuation');
      await expect(c.continueProvider('continuation', requested)).rejects.toMatchObject({ code });
      expect(f.pod()).toEqual(before);
      expect(f.repo.listRaw('continuation')).toEqual(history);
      expect(f.runtime.abort).not.toHaveBeenCalled();
      expect(f.captured.enqueueSession).not.toHaveBeenCalled();
    },
  );
  it('reports unconfirmed explicit teardown without queueing or rewriting attempt history', async () => {
    const f = fixture();
    vi.mocked(f.cm.kill).mockRejectedValueOnce(new Error('Unconfirmed kill'));
    const before = f.repo.listRaw('continuation');
    await expect(f.c.continueProvider('continuation', target)).rejects.toMatchObject({
      code: 'PROVIDER_CONTINUATION_UNSAFE',
    });
    expect(f.repo.listRaw('continuation')).toEqual(before);
    expect(f.pod().containerId).toBe('container');
    expect(f.captured.enqueueSession).not.toHaveBeenCalled();
  });
  it('retains binding/history/account/profile data through private SQLite close/reopen', async () => {
    const f = fixture(true);
    const accounts = f.accounts.list();
    const profile = f.profiles.get('test-profile');
    await f.c.queueProviderContinuation(f.pod(), target, classification, false, true);
    const history = f.repo.listRaw('continuation');
    const pod = f.pod();
    const next = f.reopen();
    expect(f.db.pragma('integrity_check', { simple: true })).toBe('ok');
    expect(f.db.pragma('foreign_key_check')).toEqual([]);
    expect(next.repo.listRaw('continuation')).toEqual(history);
    expect(next.pods.getOrThrow('continuation')).toEqual(pod);
    expect(next.accounts.list()).toEqual(accounts);
    expect(next.profiles.get('test-profile')).toEqual(profile);
  });
});
