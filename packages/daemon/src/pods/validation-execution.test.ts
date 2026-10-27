import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import type { TaskRetryIdentity, ValidationResult } from '@autopod/shared';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ValidationEngine,
  ValidationEngineConfig,
  ValidationPhaseCallbacks,
} from '../interfaces/validation-engine.js';
import {
  createMockContainerManager,
  createMockProfileStore,
  createTestDb,
  insertTestProfile,
  logger,
} from '../test-utils/mock-helpers.js';
import { createNudgeRepository } from './nudge-repository.js';
import { createPodRepository } from './pod-repository.js';
import { TaskRetryBlockedError } from './task-retry-ledger.js';
import { createValidationExecution } from './validation-execution.js';
import { ValidationSupersededError, captureValidationOwnership } from './validation-ownership.js';

vi.mock('node:timers/promises', () => ({ setTimeout: vi.fn(() => Promise.resolve()) }));
beforeEach(() => {
  vi.mocked(sleep).mockClear();
  vi.mocked(sleep).mockImplementation(() => Promise.resolve());
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

type Dependencies = Parameters<typeof createValidationExecution>[0];
const identity: TaskRetryIdentity = {
  source: 'a'.repeat(64),
  contract: 'b'.repeat(64),
  commands: 'c'.repeat(64),
  environment: null,
  implementation: null,
};
function result(kind: 'pass' | 'fail' | 'infra' | 'review' = 'pass'): ValidationResult {
  return {
    podId: 'worker',
    attempt: 1,
    timestamp: '2026-10-17T12:00:00Z',
    overall: kind === 'pass' ? 'pass' : 'fail',
    duration: 1,
    smoke: {
      status: 'pass',
      build: { status: 'pass', output: '', duration: 1 },
      health: { status: 'pass', url: '', responseCode: 200, duration: 1 },
      pages: [],
    },
    taskReview: null,
    ...(kind === 'infra'
      ? {
          infrastructureFailure: {
            phase: 'test' as const,
            code: 'SYNTHETIC_INFRA',
            message: 'synthetic infrastructure',
            retryable: true,
          },
        }
      : {}),
    ...(kind === 'review' ? { reviewSkipKind: 'review-timeout' as const } : {}),
  };
}
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'validation-execution-'));
  const file = join(directory, 'state.db');
  const seed = createTestDb();
  try {
    insertTestProfile(seed);
    writeFileSync(file, seed.serialize());
  } finally {
    seed.close();
  }
  let db = new Database(file);
  db.pragma('foreign_keys = ON');
  const repo = createPodRepository(db);
  repo.insert({
    id: 'worker',
    profileName: 'test-profile',
    task: 'Execute checks',
    status: 'validating',
    model: 'model',
    runtime: 'codex',
    executionTarget: 'local',
    branch: 'feature',
    userId: 'operator',
    maxValidationAttempts: 3,
    skipValidation: false,
    outputMode: 'pr',
    options: { agentMode: 'auto', output: 'pr', validate: true, validationSuite: 'full' },
  });
  repo.update('worker', {
    containerId: 'execution-container',
    worktreePath: '/private/execution-tree',
  });
  const pod = repo.getOrThrow('worker');
  const ledger = repo.taskRetries;
  if (!ledger) throw new Error('Missing ledger fixture');
  const nudges = createNudgeRepository(db);
  let currentInvocation = true;
  const ownership = captureValidationOwnership(pod, {
    readCurrent: () => repo.getOrThrow('worker'),
    isCurrentInvocation: () => currentInvocation,
    hasPendingDecision: () =>
      nudges.hasPending('worker') || (repo.hasUnansweredDecision?.('worker') ?? false),
  });
  const assert = vi.spyOn(ownership, 'assertCurrent');
  const controller = new AbortController();
  const cm = createMockContainerManager();
  const containerFactory = { get: vi.fn(() => cm) };
  const profile = createMockProfileStore(db).get('test-profile');
  const config: ValidationEngineConfig = {
    podId: 'worker',
    containerId: 'execution-container',
    executionTarget: 'local',
    previewUrl: 'http://preview',
    buildCommand: 'build',
    startCommand: 'start',
    healthPath: '/',
    healthTimeout: 120,
    smokePages: [],
    attempt: 1,
    validationSuite: 'full',
    task: 'Execute checks',
    diff: 'diff',
    reviewerModel: 'reviewer',
    reviewerProvider: 'anthropic',
  };
  const order: string[] = [];
  const capture = vi.fn(async (_config: ValidationEngineConfig) => {
    order.push('identity');
    return identity;
  });
  const retrySource: Dependencies['retrySource'] = {
    validationInfrastructureRetryBackoffMs: [0, 0],
    captureRetryIdentity: capture,
  };
  const provenance = vi.fn<Dependencies['recordValidationProvenance']>(
    async (_config, _purpose, assertCurrent) => {
      order.push('provenance');
      assertCurrent();
    },
  );
  const bound = vi.fn<Dependencies['resolveEffectiveBoundProfile']>(() => {
    order.push('binding');
    return profile;
  });
  const preflight = vi.fn<Dependencies['withReviewerLaunchPreflight']>((cfg, owner) => {
    order.push('preflight');
    return { ...cfg, assertReviewerCurrent: owner.assertCurrent };
  });
  const owned = vi.fn<Dependencies['ownedValidationCallbacks']>((owner, callbacks) => ({
    onPhaseStarted: (...args) => {
      if (owner.isCurrent()) callbacks?.onPhaseStarted?.(...args);
    },
    onPhaseCompleted: (...args) => {
      if (owner.isCurrent()) callbacks?.onPhaseCompleted?.(...args);
    },
    onReviewProgress: (...args) => {
      if (owner.isCurrent()) callbacks?.onReviewProgress?.(...args);
    },
  }));
  const phase = vi.fn();
  const callbacks: ValidationPhaseCallbacks = {
    onPhaseStarted: phase,
    onPhaseCompleted: vi.fn(),
    onReviewProgress: vi.fn(),
  };
  const engine = vi.fn<ValidationEngine['validate']>(async () => {
    order.push('engine');
    return result();
  });
  const activity = vi.fn<Dependencies['emitActivityStatus']>();
  const log = logger.child({ test: 'validation-execution' });
  const errors = vi.spyOn(log, 'error');
  const unexpected = vi.fn<Dependencies['makeUnexpectedValidationFailureResult']>(
    (podId, attempt, error) => ({
      ...result('fail'),
      podId,
      attempt,
      smoke: {
        ...result('fail').smoke,
        build: { status: 'fail', output: String(error), duration: 0 },
      },
    }),
  );
  const start = ledger.start.bind(ledger);
  const finish = ledger.finish.bind(ledger);
  const admitted = vi.spyOn(ledger, 'admit');
  const started = vi.spyOn(ledger, 'start').mockImplementation((id) => {
    order.push('start');
    return start(id);
  });
  const finished = vi.spyOn(ledger, 'finish').mockImplementation((...args) => {
    order.push('finish');
    return finish(...args);
  });
  const dependencies: Dependencies = {
    logger: log,
    containerManagerFactory: containerFactory,
    podRepo: repo,
    validationEngine: { validate: engine },
    retrySource,
    recordValidationProvenance: provenance,
    resolveEffectiveBoundProfile: bound,
    withReviewerLaunchPreflight: preflight,
    ownedValidationCallbacks: owned,
    emitActivityStatus: activity,
    makeUnexpectedValidationFailureResult: unexpected,
    validationInfrastructureFailureLabel: () => 'Infrastructure during test',
    isReviewInfrastructureOnlyFailure: (r) => r.reviewSkipKind === 'review-timeout',
    reviewInfrastructureFailureLabel: () => 'Review unavailable',
  };
  const module = createValidationExecution(dependencies);
  return {
    repo,
    pod,
    ledger,
    nudges,
    ownership,
    assert,
    controller,
    cm,
    containerFactory,
    profile,
    config,
    order,
    capture,
    retrySource,
    provenance,
    bound,
    preflight,
    owned,
    phase,
    callbacks,
    engine,
    activity,
    errors,
    unexpected,
    admitted,
    started,
    finished,
    dependencies,
    run: (message = 'engine failed') =>
      module.validateWithInfrastructureRetries(config, controller, callbacks, message, ownership),
    replace() {
      repo.update('worker', { containerId: 'replacement-container' });
    },
    supersede() {
      currentInvocation = false;
    },
    reopen() {
      db.close();
      db = new Database(file);
      db.pragma('foreign_keys = ON');
      expect(db.pragma('integrity_check', { simple: true })).toBe('ok');
      expect(db.pragma('foreign_key_check')).toEqual([]);
      const reopened = createPodRepository(db);
      const state = reopened.taskRetries?.state('worker');
      if (!state) throw new Error('Missing reopened ledger');
      const rows = db
        .prepare(
          'SELECT outcome, started_at, ended_at, measured_duration_ms FROM task_retry_attempts WHERE pod_id = ? ORDER BY rowid',
        )
        .all('worker') as Array<{
        outcome: string | null;
        started_at: string | null;
        ended_at: string | null;
        measured_duration_ms: number | null;
      }>;
      return { state, rows, pod: reopened.getOrThrow('worker') };
    },
    close() {
      db.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

describe('validation execution durable effects', () => {
  it('constructs without I/O and preserves config, collector, signal and engine argument identities', async () => {
    const f = fixture();
    try {
      expect(f.order).toEqual([]);
      expect(f.admitted).not.toHaveBeenCalled();
      expect(f.containerFactory.get).not.toHaveBeenCalled();
      const collector = vi.fn(async () => undefined);
      f.config.captureEvidenceIdentity = collector;
      const out = await f.run();
      expect(out).toBe(await f.engine.mock.results[0]?.value);
      expect(f.config.captureEvidenceIdentity).toBe(collector);
      expect(collector).not.toHaveBeenCalled();
      expect(f.capture).toHaveBeenCalledWith(f.config);
      expect(f.provenance).toHaveBeenCalledWith(f.config, 'validation', f.ownership.assertCurrent);
      expect(f.preflight).toHaveBeenCalledWith(f.config, f.ownership);
      expect(f.engine.mock.calls[0]?.[0]).toBe(f.preflight.mock.results[0]?.value);
      expect(f.engine.mock.calls[0]?.[2]).toBe(f.controller.signal);
      expect(f.engine.mock.calls[0]?.[3]).toBe(f.owned.mock.results[0]?.value);
      expect(f.order).toEqual([
        'provenance',
        'identity',
        'binding',
        'binding',
        'start',
        'preflight',
        'engine',
        'finish',
      ]);
      expect(f.admitted).toHaveBeenCalledWith(
        'worker',
        f.pod.lifecycleGeneration,
        identity,
        '7368d9181c38e7233796236711a5e606168ebeb4fbc820b9f13d559e71a77ae0',
        [0, 0],
      );
      expect(f.admitted.mock.calls[0]?.[4]).not.toBe(
        f.retrySource.validationInfrastructureRetryBackoffMs,
      );
      const stored = f.reopen();
      expect(stored.state).toMatchObject({
        admissionCount: 1,
        executedCount: 1,
        latest: { outcome: 'pass' },
      });
      expect(stored.rows[0]?.measured_duration_ms).toBeGreaterThanOrEqual(0);
      expect(stored.pod.status).toBe('validating');
    } finally {
      f.close();
    }
  });

  it.each(['local', 'sandbox', 'fallback'] as const)(
    'preserves container selection: %s',
    async (target) => {
      const f = fixture();
      try {
        f.config.executionTarget = target === 'fallback' ? undefined : target;
        await f.run();
        expect(f.containerFactory.get).toHaveBeenCalledWith(
          target === 'sandbox' ? 'sandbox' : 'local',
        );
        expect(typeof f.config.captureEvidenceIdentity).toBe('function');
        expect(f.cm.execInContainer).not.toHaveBeenCalled();
      } finally {
        f.close();
      }
    },
  );

  it.each(['pass', 'fail', 'infra', 'review', 'throw', 'preflight', 'callbacks', 'abort'] as const)(
    'persists the existing settlement for %s',
    async (kind) => {
      const f = fixture();
      try {
        f.retrySource.validationInfrastructureRetryBackoffMs = [];
        const original = result(
          kind === 'pass' || kind === 'abort'
            ? 'pass'
            : kind === 'infra'
              ? 'infra'
              : kind === 'review'
                ? 'review'
                : 'fail',
        );
        const fault = new Error(`synthetic-${kind}`);
        f.engine.mockImplementationOnce(async () => {
          if (kind === 'throw') throw fault;
          if (kind === 'abort') f.controller.abort();
          return original;
        });
        if (kind === 'preflight')
          f.preflight.mockImplementationOnce(() => {
            throw fault;
          });
        if (kind === 'callbacks')
          f.owned.mockImplementationOnce(() => {
            throw fault;
          });
        const out = await f.run('caller-specific log');
        const converted = ['throw', 'preflight', 'callbacks'].includes(kind);
        if (converted) {
          expect(f.unexpected).toHaveBeenCalledWith('worker', 1, fault);
          expect(out).toBe(f.unexpected.mock.results[0]?.value);
          expect(f.errors).toHaveBeenCalledWith(
            { err: fault, podId: 'worker', attempt: 1 },
            'caller-specific log',
          );
        } else expect(out).toBe(original);
        expect(f.engine).toHaveBeenCalledTimes(
          kind === 'preflight' || kind === 'callbacks' ? 0 : 1,
        );
        const settled =
          kind === 'abort'
            ? 'cancelled'
            : kind === 'pass'
              ? 'pass'
              : kind === 'infra' || kind === 'review'
                ? 'transient'
                : 'nonretryable';
        const stored = f.reopen();
        expect(stored.state).toMatchObject({
          admissionCount: 1,
          executedCount: 1,
          latest: { outcome: settled },
        });
        expect(stored.rows[0]?.started_at).not.toBeNull();
        expect(stored.rows[0]?.measured_duration_ms).toBeGreaterThanOrEqual(0);
        if (kind === 'review')
          expect(f.activity).toHaveBeenCalledWith(
            'worker',
            'Review unavailable after one Review retry — needs human review',
          );
      } finally {
        f.close();
      }
    },
  );

  it('persists transient then pass outcomes without changing the selected result identity', async () => {
    const f = fixture();
    try {
      const first = result('infra');
      const second = result();
      f.engine.mockResolvedValueOnce(first).mockResolvedValueOnce(second);
      expect(await f.run()).toBe(second);
      expect(f.engine).toHaveBeenCalledTimes(2);
      const stored = f.reopen();
      expect(stored.state).toMatchObject({
        admissionCount: 2,
        executedCount: 2,
        transientRetryCount: 1,
        latest: { outcome: 'pass' },
      });
      expect(stored.rows.map((r) => r.outcome)).toEqual(['transient', 'pass']);
      expect(
        stored.rows.every(
          (r) =>
            Number.isSafeInteger(r.measured_duration_ms) && Number(r.measured_duration_ms) >= 0,
        ),
      ).toBe(true);
    } finally {
      f.close();
    }
  });

  it.each([[], [0], [10], undefined])(
    'pins the actual configured/default policy %s',
    async (backoffs) => {
      const f = fixture();
      try {
        f.retrySource.validationInfrastructureRetryBackoffMs = backoffs;
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.mocked(sleep).mockImplementation(async (delay) => {
          vi.setSystemTime(Date.now() + (typeof delay === 'number' ? delay : 0));
        });
        const failed = result('infra');
        f.engine.mockResolvedValue(failed);
        expect(await f.run()).toBe(failed);
        const selected = backoffs ?? [1000, 5000];
        expect(f.engine).toHaveBeenCalledTimes(1 + selected.length);
        const stored = f.reopen();
        expect(stored.state).toMatchObject({
          backoffsMs: selected,
          admissionCount: 1 + selected.length,
          executedCount: 1 + selected.length,
        });
      } finally {
        vi.useRealTimers();
        f.close();
      }
    },
  );

  it.each([[], [0], [5], undefined])(
    'preserves no-ledger behavior for schedule %s',
    async (backoffs) => {
      const f = fixture();
      try {
        f.repo.taskRetries = undefined;
        f.retrySource.validationInfrastructureRetryBackoffMs = backoffs;
        const failed = result('infra');
        f.engine.mockResolvedValue(failed);
        expect(await f.run()).toBe(failed);
        const selected = backoffs ?? [1000, 5000];
        expect(f.engine).toHaveBeenCalledTimes(1 + selected.length);
        expect(vi.mocked(sleep).mock.calls.map(([delay]) => delay)).toEqual(
          selected.filter((n) => n > 0),
        );
        expect(f.capture).not.toHaveBeenCalled();
        expect(f.admitted).not.toHaveBeenCalled();
        expect(f.reopen().rows).toEqual([]);
      } finally {
        f.close();
      }
    },
  );

  it.each(['valid', 'unavailable'] as const)(
    'uses the real retry identity fallback: %s',
    async (probe) => {
      const f = fixture();
      try {
        f.retrySource.captureRetryIdentity = undefined;
        vi.mocked(f.cm.execInContainer).mockResolvedValueOnce({
          exitCode: probe === 'valid' ? 0 : 1,
          stdout:
            probe === 'valid'
              ? JSON.stringify({ source: 'e'.repeat(64), node: '22.23.3' })
              : 'null',
          stderr: '',
        });
        await f.run();
        expect(f.capture).not.toHaveBeenCalled();
        expect(f.cm.execInContainer).toHaveBeenCalledWith(
          'execution-container',
          ['node', '-e', expect.stringContaining('files.length > 100000')],
          { cwd: '/workspace', timeout: 30000 },
        );
        expect(f.reopen().state.latest?.identity.source).toBe(
          probe === 'valid' ? 'e'.repeat(64) : null,
        );
      } finally {
        f.close();
      }
    },
  );

  it('reads the current optional capture callback after construction and each retry', async () => {
    const f = fixture();
    try {
      const second = vi.fn(async () => ({ ...identity, source: 'f'.repeat(64) }));
      const first = vi.fn(async () => {
        f.retrySource.captureRetryIdentity = second;
        return identity;
      });
      f.retrySource.captureRetryIdentity = first;
      f.engine.mockResolvedValueOnce(result('infra')).mockResolvedValueOnce(result());
      await f.run();
      expect(first).toHaveBeenCalledOnce();
      expect(second).toHaveBeenCalledOnce();
      expect(f.capture).not.toHaveBeenCalled();
      expect(f.reopen().state.latest?.identity.source).toBe('f'.repeat(64));
    } finally {
      f.close();
    }
  });

  it('retains persisted exhaustion across invocations and the last executed authorized result', async () => {
    const f = fixture();
    try {
      f.retrySource.validationInfrastructureRetryBackoffMs = [];
      f.engine.mockResolvedValue(result('infra'));
      await f.run();
      f.ledger.authorize('worker', 'one-extra', 'Inspected external prerequisite', {
        type: 'human',
        userId: 'operator',
      });
      f.retrySource.validationInfrastructureRetryBackoffMs = [0];
      const authorized = result('infra');
      f.engine.mockResolvedValueOnce(authorized);
      expect(await f.run()).toBe(authorized);
      expect(f.engine).toHaveBeenCalledTimes(2);
      const stored = f.reopen();
      expect(stored.state).toMatchObject({
        backoffsMs: [],
        admissionCount: 2,
        executedCount: 2,
        latest: { outcome: 'transient', retryKind: 'override' },
      });
      expect(stored.pod.failureReason).toContain('retry budget exhausted');
      expect(stored.rows.map((r) => r.outcome)).toEqual(['transient', 'transient']);
    } finally {
      f.close();
    }
  });

  it('propagates real first-admission refusal without another engine execution', async () => {
    const f = fixture();
    try {
      f.engine.mockResolvedValueOnce(result('fail'));
      await f.run();
      await expect(f.run()).rejects.toBeInstanceOf(TaskRetryBlockedError);
      expect(f.engine).toHaveBeenCalledOnce();
      expect(f.reopen().state).toMatchObject({
        admissionCount: 1,
        executedCount: 1,
        latest: { outcome: 'nonretryable' },
      });
    } finally {
      f.close();
    }
  });

  it.each(['abort', 'replacement', 'stalled clock', 'early wake'] as const)(
    'preserves persisted cooldown for %s',
    async (mode) => {
      const f = fixture();
      try {
        f.retrySource.validationInfrastructureRetryBackoffMs = [10];
        vi.useFakeTimers({ toFake: ['Date'] });
        let wakes = 0;
        vi.mocked(sleep).mockImplementation(async (delay) => {
          const ms = typeof delay === 'number' ? delay : 0;
          if (mode === 'abort') f.controller.abort();
          else if (mode === 'replacement') f.replace();
          else if (mode === 'early wake')
            vi.setSystemTime(Date.now() + ms - (wakes++ === 0 ? 1 : 0));
        });
        const failed = result('infra');
        f.engine.mockResolvedValueOnce(failed).mockResolvedValueOnce(result());
        if (mode === 'replacement')
          await expect(f.run()).rejects.toBeInstanceOf(ValidationSupersededError);
        else if (mode === 'early wake') expect((await f.run()).overall).toBe('pass');
        else expect(await f.run()).toBe(failed);
        expect(f.engine).toHaveBeenCalledTimes(mode === 'early wake' ? 2 : 1);
        const stored = f.reopen();
        expect(stored.state).toMatchObject({
          admissionCount: 2,
          executedCount: mode === 'early wake' ? 2 : 1,
        });
        expect(stored.rows[1]).toMatchObject(
          mode === 'early wake'
            ? { outcome: 'pass' }
            : { outcome: 'cancelled', started_at: null, measured_duration_ms: null },
        );
        if (mode === 'early wake')
          expect(vi.mocked(sleep).mock.calls.map(([delay]) => delay)).toEqual([10, 1]);
        if (mode === 'stalled clock') expect(sleep).toHaveBeenCalledTimes(3);
      } finally {
        vi.useRealTimers();
        f.close();
      }
    },
  );

  it.each(
    (['provenance', 'identity', 'engine'] as const).flatMap((stage) =>
      [false, true].map((reject) => ({ stage, reject })),
    ),
  )('preserves supersession at $stage (reject=$reject)', async ({ stage, reject }) => {
    const f = fixture();
    const fault = new Error('superseded dependency');
    try {
      if (stage === 'provenance')
        f.provenance.mockImplementationOnce(async () => {
          f.replace();
          if (reject) throw fault;
        });
      if (stage === 'identity')
        f.capture.mockImplementationOnce(async () => {
          f.replace();
          if (reject) throw fault;
          return identity;
        });
      if (stage === 'engine')
        f.engine.mockImplementationOnce(async (_cfg, progress, _signal, callbacks) => {
          f.replace();
          progress?.('stale');
          callbacks?.onPhaseStarted?.('test');
          if (reject) throw fault;
          return result();
        });
      await expect(f.run()).rejects.toBeInstanceOf(ValidationSupersededError);
      const stored = f.reopen();
      expect(stored.pod.containerId).toBe('replacement-container');
      expect(stored.state).toMatchObject({
        admissionCount: stage === 'engine' ? 1 : 0,
        executedCount: stage === 'engine' ? 1 : 0,
      });
      if (stage === 'engine') {
        expect(stored.state.latest?.outcome).toBe(reject ? 'nonretryable' : 'pass');
        expect(f.phase).not.toHaveBeenCalled();
        expect(f.activity).not.toHaveBeenCalled();
        const finishOrder = f.finished.mock.invocationCallOrder[0];
        const finalAssert = f.assert.mock.invocationCallOrder.at(-1);
        expect(finishOrder).toBeLessThan(finalAssert ?? 0);
      }
    } finally {
      f.close();
    }
  });

  it('keeps the started outcome when pending guidance supersedes a completed engine', async () => {
    const f = fixture();
    try {
      f.engine.mockImplementationOnce(async () => {
        f.nudges.queue('worker', 'New operator guidance');
        return result();
      });
      await expect(f.run()).rejects.toBeInstanceOf(ValidationSupersededError);
      expect(f.reopen().state).toMatchObject({ executedCount: 1, latest: { outcome: 'pass' } });
    } finally {
      f.close();
    }
  });

  it.each([
    'provenance',
    'identity',
    'admit',
    'start',
    'finish',
    'cancel-finish',
    'later-identity',
  ] as const)('preserves error identity and partial records for %s failure', async (stage) => {
    const f = fixture();
    const fault = new Error(`synthetic-${stage}`);
    try {
      if (stage === 'provenance') f.provenance.mockRejectedValueOnce(fault);
      if (stage === 'identity') f.capture.mockRejectedValueOnce(fault);
      if (stage === 'admit')
        f.admitted.mockImplementationOnce(() => {
          throw fault;
        });
      if (stage === 'start')
        f.started.mockImplementationOnce(() => {
          throw fault;
        });
      if (stage === 'finish')
        f.finished.mockImplementationOnce(() => {
          throw fault;
        });
      if (stage === 'cancel-finish') {
        f.started.mockImplementationOnce(() => {
          throw new Error('original start fault');
        });
        f.finished.mockImplementationOnce(() => {
          throw fault;
        });
      }
      if (stage === 'later-identity') {
        f.engine.mockResolvedValueOnce(result('infra'));
        f.capture.mockResolvedValueOnce(identity).mockRejectedValueOnce(fault);
      }
      await expect(f.run()).rejects.toBe(fault);
      const stored = f.reopen();
      const admission = ['start', 'finish', 'cancel-finish', 'later-identity'].includes(stage);
      expect(stored.state.admissionCount).toBe(admission ? 1 : 0);
      expect(stored.state.executedCount).toBe(
        stage === 'finish' || stage === 'later-identity' ? 1 : 0,
      );
      if (stage === 'start')
        expect(stored.rows[0]).toMatchObject({
          outcome: 'cancelled',
          started_at: null,
          measured_duration_ms: null,
        });
      if (stage === 'finish')
        expect(stored.rows[0]).toMatchObject({
          outcome: null,
          ended_at: null,
          measured_duration_ms: null,
        });
      if (stage === 'cancel-finish')
        expect(stored.rows[0]).toMatchObject({ outcome: null, started_at: null, ended_at: null });
      if (stage === 'later-identity') expect(stored.rows[0]?.outcome).toBe('transient');
    } finally {
      f.close();
    }
  });

  it('forwards current progress/phase callbacks and filters them when the invocation is replaced', async () => {
    const f = fixture();
    try {
      f.engine.mockImplementationOnce(async (_cfg, progress, _signal, callbacks) => {
        progress?.('current phase');
        callbacks?.onPhaseStarted?.('test');
        f.supersede();
        progress?.('stale phase');
        callbacks?.onPhaseStarted?.('test');
        return result();
      });
      await expect(f.run()).rejects.toBeInstanceOf(ValidationSupersededError);
      expect(f.activity.mock.calls).toEqual([['worker', 'current phase']]);
      expect(f.phase).toHaveBeenCalledOnce();
      expect(f.reopen().state.latest?.outcome).toBe('pass');
    } finally {
      f.close();
    }
  });

  it.each(['replacement', 'invocation'] as const)(
    'rejects initial stale %s ownership before container or ledger work',
    async (mode) => {
      const f = fixture();
      try {
        if (mode === 'replacement') f.replace();
        else f.supersede();
        await expect(f.run()).rejects.toBeInstanceOf(ValidationSupersededError);
        expect(f.containerFactory.get).not.toHaveBeenCalled();
        expect(f.provenance).not.toHaveBeenCalled();
        expect(f.engine).not.toHaveBeenCalled();
        expect(f.reopen().rows).toEqual([]);
      } finally {
        f.close();
      }
    },
  );

  it('propagates container selection failure before attaching a collector or admitting work', async () => {
    const f = fixture();
    const fault = new Error('container unavailable');
    try {
      f.containerFactory.get.mockImplementationOnce(() => {
        throw fault;
      });
      await expect(f.run()).rejects.toBe(fault);
      expect(f.config.captureEvidenceIdentity).toBeUndefined();
      expect(f.provenance).not.toHaveBeenCalled();
      expect(f.engine).not.toHaveBeenCalled();
      expect(f.reopen().rows).toEqual([]);
    } finally {
      f.close();
    }
  });

  it('does not retry a typed infrastructure result whose retryable flag is false', async () => {
    const f = fixture();
    try {
      const failed: ValidationResult = {
        ...result('infra'),
        infrastructureFailure: {
          phase: 'test',
          code: 'SYNTHETIC_FIXED',
          message: 'no retry',
          retryable: false,
        },
      };
      f.engine.mockResolvedValueOnce(failed);
      expect(await f.run()).toBe(failed);
      expect(f.engine).toHaveBeenCalledOnce();
      expect(f.reopen().state).toMatchObject({
        admissionCount: 1,
        executedCount: 1,
        latest: { outcome: 'nonretryable' },
      });
    } finally {
      f.close();
    }
  });

  it.each(['confirmed', 'failed', 'unverified'] as const)(
    'durably blocks repeated timeout after %s cleanup',
    async (cleanup) => {
      const f = fixture();
      try {
        const failed: ValidationResult = {
          ...result('infra'),
          test: { status: 'skip', duration: 600751, stdout: 'FAIL real test' },
          infrastructureFailure: {
            phase: 'test',
            code: 'EXEC_EXIT_UNVERIFIED',
            retryable: false,
            message: 'Timeout; command exit is unverified',
            execution: { cause: 'timeout', timeoutMs: 600_000, cleanup },
          },
        };
        f.engine.mockResolvedValueOnce(failed);
        expect(await f.run()).toBe(failed);
        await expect(f.run()).rejects.toBeInstanceOf(TaskRetryBlockedError);
        expect(f.engine).toHaveBeenCalledOnce();
        expect(f.reopen().state).toMatchObject({
          admissionCount: 1,
          executedCount: 1,
          latest: { outcome: 'nonretryable' },
        });
      } finally {
        f.close();
      }
    },
  );

  it('retains the invocation ledger reference when its repository property changes during execution', async () => {
    const f = fixture();
    try {
      f.engine
        .mockImplementationOnce(async () => {
          f.repo.taskRetries = undefined;
          return result('infra');
        })
        .mockResolvedValueOnce(result());
      expect((await f.run()).overall).toBe('pass');
      expect(f.admitted).toHaveBeenCalledTimes(2);
      expect(f.reopen().state).toMatchObject({
        admissionCount: 2,
        executedCount: 2,
        latest: { outcome: 'pass' },
      });
    } finally {
      f.close();
    }
  });

  it('retains an attached collector on the same config across later invocations', async () => {
    const f = fixture();
    try {
      await f.run();
      const attached = f.config.captureEvidenceIdentity;
      expect(typeof attached).toBe('function');
      await f.run();
      expect(f.config.captureEvidenceIdentity).toBe(attached);
      expect(f.engine.mock.calls[1]?.[0].captureEvidenceIdentity).toBe(attached);
      expect(f.reopen().state).toMatchObject({
        admissionCount: 2,
        executedCount: 2,
        latest: { outcome: 'pass' },
      });
    } finally {
      f.close();
    }
  });
});
