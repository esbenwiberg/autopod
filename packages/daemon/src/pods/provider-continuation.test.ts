import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProviderFailureClassification } from '@autopod/shared';
import { PROVIDER_FAILOVER_HANDOFF_PATH, WORKSPACE_PRESERVATION_FAILED } from '@autopod/shared';
import pino from 'pino';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDatabase } from '../db/connection.js';
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
import { createEscalationRepository } from './escalation-repository.js';
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
    db = createDatabase(filename, pino({ level: 'silent' }));
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
      db = createDatabase(filename, pino({ level: 'silent' }));
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
  it.each(
    [false, true].flatMap((automatic) =>
      ['before', 'abort', 'sync', 'preview', 'deny', 'kill', 'handoff'].map((stage) => ({
        automatic,
        stage,
      })),
    ),
  )('fences infrastructure before provider authorization/teardown/queueing (%j)', async ({
    automatic,
    stage,
  }) => {
    const f = fixture();
    if (!automatic) f.podRepo.update('continuation', { status: 'failed', pauseReason: null });
    const before = f.pod();
    const attempts = f.repo.list('continuation');
    const report = () =>
      createEscalationRepository(f.db).insert({
        id: 'provider-infrastructure',
        podId: 'continuation',
        type: 'report_blocker',
        timestamp: new Date().toISOString(),
        response: null,
        payload: {
          kind: 'infrastructure',
          lifecycleGeneration: f.pod().lifecycleGeneration,
          requiresResponse: false,
          description: 'Configured environment unavailable',
          attempted: [],
          needs: 'Qualified execution',
        },
      });
    const arrive = async () => {
      report();
    };
    if (stage === 'before') report();
    else if (stage === 'abort') vi.mocked(f.runtime.abort).mockImplementationOnce(arrive);
    else if (stage === 'sync')
      f.captured.syncWorkspaceBack.mockImplementationOnce(async () => {
        report();
        return { pushed: false };
      });
    else if (stage === 'preview') f.captured.stopSandboxPreviewProxy.mockImplementationOnce(arrive);
    else if (stage === 'deny') f.captured.stopHaproxyDenyReceiver.mockImplementationOnce(arrive);
    else if (stage === 'kill') vi.mocked(f.cm.kill).mockImplementationOnce(arrive);
    else f.captured.worktreeManager.ensureExcludes.mockImplementationOnce(arrive);
    if (automatic) await f.c.handleProviderLimit('continuation', classification);
    else
      await expect(f.c.continueProvider('continuation', 'profile-primary')).rejects.toMatchObject({
        code: 'INFRASTRUCTURE_BLOCKED',
      });
    // Effects already admitted before the report remain truthful; no later
    // teardown, target attempt, or queue admission is allowed after the hold.
    // A completed sync before the hold is a truthful preservation receipt (#670) on the
    // automatic path. An operator continuation records it only once teardown committed,
    // so a rejected operator continuation leaves the pod unchanged.
    const synced = automatic ? !['before', 'abort', 'sync'].includes(stage) : stage === 'handoff';
    expect(f.pod()).toEqual({
      ...before,
      containerId: stage === 'handoff' ? null : before.containerId,
      ...(stage === 'handoff' ? { updatedAt: expect.any(String) } : {}),
      ...(synced
        ? {
            finalization: expect.objectContaining({ sourcePreservedAt: expect.any(String) }),
          }
        : {}),
    });
    expect(f.repo.list('continuation')).toEqual(attempts);
    expect(f.runtime.abort).toHaveBeenCalledTimes(stage === 'before' ? 0 : 1);
    expect(f.captured.syncWorkspaceBack).toHaveBeenCalledTimes(
      ['before', 'abort'].includes(stage) ? 0 : 1,
    );
    expect(f.cm.kill).toHaveBeenCalledTimes(['kill', 'handoff'].includes(stage) ? 1 : 0);
    expect(f.captured.enqueueSession).not.toHaveBeenCalled();
    expect(
      createEscalationRepository(f.db).getOrThrow('provider-infrastructure').response,
    ).toBeNull();
  });
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
  it.each([
    false,
    true,
  ])('queues alternate bindings with defer=%s and clears old native sessions', async (defer) => {
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
  });
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
  it.each([
    'abort',
    'sync',
    'kill',
    'timeout',
  ] as const)('fails closed during automatic %s drain and cleans timers', async (stage) => {
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
  });
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
  describe('workspace preservation receipts (#670)', () => {
    const syncContainerOnlyWork = (f: ReturnType<typeof fixture>) =>
      f.captured.syncWorkspaceBack.mockImplementationOnce(async () => {
        f.order.push('sync');
        writeFileSync(join(f.directory, 'phase2-untracked.ts'), 'uncommitted phase 2\n');
        return { pushed: false };
      });

    it('records Source saved after the provider-limit sync, before teardown', async () => {
      const f = fixture();
      syncContainerOnlyWork(f);
      let preservedBeforeKill: string | null | undefined;
      vi.mocked(f.cm.kill).mockImplementationOnce(async () => {
        preservedBeforeKill = f.pod().finalization?.sourcePreservedAt;
        f.order.push('kill');
      });
      expect(await f.c.handleProviderLimit('continuation', classification)).toBe('queued');
      expect(f.order.indexOf('sync')).toBeLessThan(f.order.indexOf('kill'));
      expect(preservedBeforeKill).toEqual(expect.any(String));
      expect(readFileSync(join(f.directory, 'phase2-untracked.ts'), 'utf8')).toBe(
        'uncommitted phase 2\n',
      );
      expect(f.pod()).toMatchObject({ status: 'queued', recoveryWorktreePath: f.directory });
    });

    it('records an explicit preservation failure and keeps the container when sync fails', async () => {
      const f = fixture();
      f.captured.syncWorkspaceBack.mockRejectedValueOnce(new Error('sync-back exec failed'));
      expect(await f.c.handleProviderLimit('continuation', classification)).toBe('not_queued');
      expect(f.cm.kill).not.toHaveBeenCalled();
      expect(f.pod()).toMatchObject({ status: 'paused', containerId: 'container' });
      expect(f.pod().finalization?.sourcePreservedAt ?? null).toBeNull();
      expect(f.pod().failureReason).toContain(WORKSPACE_PRESERVATION_FAILED);
      expect(f.pod().failureReason).toContain('container retained');
      expect(f.captured.emitActivityStatus).toHaveBeenCalledWith(
        'continuation',
        expect.stringContaining('original container is retained'),
      );
    });

    it('records Source saved for an operator continue-provider and its failure', async () => {
      const ok = fixture();
      syncContainerOnlyWork(ok);
      await ok.c.continueProvider('continuation', target);
      expect(ok.pod().status).toBe('queued');
      expect(existsSync(join(ok.directory, 'phase2-untracked.ts'))).toBe(true);

      const failed = fixture();
      failed.captured.syncWorkspaceBack.mockRejectedValueOnce(new Error('sync-back exec failed'));
      await expect(failed.c.continueProvider('continuation', target)).rejects.toMatchObject({
        code: 'PROVIDER_CONTINUATION_UNSAFE',
      });
      expect(failed.cm.kill).not.toHaveBeenCalled();
      expect(failed.pod().containerId).toBe('container');
      expect(failed.pod().failureReason).toContain(WORKSPACE_PRESERVATION_FAILED);
    });
  });
  describe('prepared dependency capture (#644)', () => {
    const previous = process.env.AUTOPOD_PREPARED_DEPENDENCIES_DIR;
    afterEach(() => {
      if (previous === undefined) delete process.env.AUTOPOD_PREPARED_DEPENDENCIES_DIR;
      else process.env.AUTOPOD_PREPARED_DEPENDENCIES_DIR = previous;
    });
    function withPreparedContainer(f: ReturnType<typeof fixture>, failExport = false) {
      process.env.AUTOPOD_PREPARED_DEPENDENCIES_DIR = join(f.directory, '.snapshots');
      Object.assign(f.podRepo, {
        executionProvenance: {
          record: vi.fn(),
          latest: () => ({
            imageDigest: `sha256:${'f'.repeat(64)}`,
            repositoryPreparation: {
              status: 'passed',
              containerId: 'container',
              commandHash: 'a'.repeat(64),
              configurationHash: 'b'.repeat(64),
              source: { head: 'c'.repeat(40), fingerprint: 'd'.repeat(64) },
              exitCode: 0,
              dependencyInputs: 'e'.repeat(64),
              outsideWorkspaceWrites: 'none',
            },
          }),
        },
      });
      vi.mocked(f.cm.execInContainer).mockImplementation(async () => ({
        exitCode: 0,
        stdout: '/workspace/node_modules\n',
        stderr: '',
      }));
      Object.assign(f.cm, {
        importPathArchive: vi.fn(),
        exportPathArchive: vi.fn(async (_id: string, _path: string, file: string) => {
          f.order.push('capture');
          if (failExport) throw new Error('docker unavailable');
          writeFileSync(file, 'tar');
          return { bytes: 3, sha256: '0'.repeat(64) };
        }),
      });
      vi.mocked(f.runtime.abort).mockImplementationOnce(async () => {
        f.order.push('abort');
      });
      vi.mocked(f.cm.kill).mockImplementationOnce(async () => {
        f.order.push('kill');
      });
    }

    it('captures after the runtime drain and sync-back, before the automatic teardown', async () => {
      const f = fixture();
      withPreparedContainer(f);
      expect(await f.c.handleProviderLimit('continuation', classification)).toBe('queued');
      const relevant = f.order.filter((step) =>
        ['abort', 'sync', 'capture', 'kill'].includes(step),
      );
      expect(relevant).toEqual(['abort', 'sync', 'capture', 'kill']);
      expect(f.order.some((line) => line.startsWith('Prepared dependencies saved'))).toBe(true);
      expect(
        readFileSync(join(f.directory, '.snapshots', 'continuation', 'manifest.json'), 'utf8'),
      ).toContain('"sourceContainerId":"container"');
    });

    it('captures before the operator-selected teardown', async () => {
      const f = fixture();
      withPreparedContainer(f);
      await f.c.continueProvider('continuation', target);
      expect(f.order.filter((step) => ['abort', 'sync', 'capture', 'kill'].includes(step))).toEqual(
        ['abort', 'sync', 'capture', 'kill'],
      );
      expect(f.pod().status).toBe('queued');
    });

    it('never blocks the continuation when capture fails', async () => {
      const f = fixture();
      withPreparedContainer(f, true);
      expect(await f.c.handleProviderLimit('continuation', classification)).toBe('queued');
      expect(f.order).toContain('kill');
      expect(f.order).toContain('Prepared dependencies not saved for continuation — export-failed');
      expect(f.pod()).toMatchObject({ status: 'queued', containerId: null });
    });
  });
  it.each([
    'same',
    'alternate',
    'primary',
  ] as const)('returns the original explicit %s continuation action', async (mode) => {
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
  });
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
  it.each([
    'worker',
    'evidence',
    'policy',
    'same-hop',
  ] as const)('retains source before explicit %s guard denial', async (reason) => {
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
  });
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
