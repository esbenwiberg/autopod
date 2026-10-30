import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ValidationResult } from '@autopod/shared';
import Database from 'better-sqlite3';
import pino from 'pino';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ValidationEngine } from '../interfaces/validation-engine.js';
import { createTestDb, insertTestProfile } from '../test-utils/mock-helpers.js';
import { createAdvisoryValidation } from './advisory-validation.js';
import { createEventBus } from './event-bus.js';
import { createEventRepository } from './event-repository.js';
import { createNudgeRepository } from './nudge-repository.js';
import { type PodUpdates, createPodRepository } from './pod-repository.js';
import { createReadinessService } from './readiness-review.js';
import { ValidationSupersededError } from './validation-ownership.js';
import { createValidationProgress } from './validation-progress.js';
import { createValidationRepository } from './validation-repository.js';

type Advisory = NonNullable<ValidationResult['advisoryBrowserQa']>;
type Config = Parameters<ValidationEngine['validate']>[0];
type Runner = NonNullable<ValidationEngine['runAdvisoryBrowserQa']>;
const logger = pino({ level: 'silent' });
const cleanups: Array<() => void> = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const close of cleanups.splice(0).reverse()) close();
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function result(): ValidationResult {
  return {
    podId: 'advisory',
    attempt: 1,
    timestamp: '2026-10-18T12:00:00Z',
    smoke: {
      status: 'pass',
      build: { status: 'pass', output: '', duration: 1 },
      health: { status: 'pass', url: 'http://fixture', responseCode: 200, duration: 1 },
      pages: [],
    },
    taskReview: null,
    overall: 'pass',
    duration: 2,
    reviewSkipReason: 'Independent waiver/evidence marker',
  };
}
function qa(): Advisory {
  return {
    status: 'pass',
    reasoning: 'Observed QA',
    observations: [],
    screenshots: [],
    durationMs: 3,
    tokenUsage: { inputTokens: 11, outputTokens: 3, cachedInputTokens: 2, costUsd: 0.02 },
  };
}
function insertPod(repo: ReturnType<typeof createPodRepository>) {
  repo.insert({
    id: 'advisory',
    profileName: 'test-profile',
    task: 'Advisory boundary',
    status: 'validated',
    runtime: 'claude',
    model: 'fixture-model',
    executionTarget: 'local',
    branch: 'autopod/advisory',
    userId: 'operator',
    maxValidationAttempts: 3,
    skipValidation: false,
    outputMode: 'pr',
  });
  repo.update('advisory', {
    containerId: 'fixture-container',
    worktreePath: '/tmp/advisory',
    lastValidationResult: result(),
  });
  return repo.getOrThrow('advisory');
}
function config(): Config {
  return {
    podId: 'advisory',
    containerId: 'fixture-container',
    previewUrl: 'http://fixture',
    buildCommand: 'build',
    startCommand: 'start',
    healthPath: '/',
    healthTimeout: 10,
    smokePages: [],
    attempt: 1,
    task: 'Advisory boundary',
    diff: 'fixture-diff',
  };
}
function fixture() {
  const db = createTestDb();
  cleanups.push(() => db.close());
  insertTestProfile(db);
  const repository = createPodRepository(db);
  const pod = insertPod(repository);
  const state = { pod: structuredClone(pod), pending: false, latest: true, unanswered: false };
  const trace: string[] = [];
  const runs = new Map<string, Promise<ValidationResult>>();
  const event = vi.fn((_event: unknown) => {
    trace.push('event');
    return 1;
  });
  const progress = createValidationProgress({ eventBus: { emit: event } });
  const runner = vi.fn<Runner>(async () => qa());
  const get = vi.fn((_id: string) => state.pod);
  const update = vi.fn((_id: string, changes: PodUpdates) => {
    trace.push(changes.phaseTokenUsage ? 'usage' : 'live');
    Object.assign(state.pod, changes);
    return state.pod;
  });
  const history = vi.fn((_id: string, _validationId: string, _value: Advisory) => {
    trace.push('history');
    return true;
  });
  const readiness = vi.fn((_id: string, _options?: { advisoryQaInFlight?: boolean }) => {
    trace.push('readiness');
    return true;
  });
  const acquire = vi.fn(async () => {
    trace.push('acquire');
  });
  const release = vi.fn(() => {
    trace.push('release');
  });
  const warn = vi.fn();
  const activity = vi.fn((_id: string, _message: string) => {
    trace.push('activity');
  });
  const deps: Parameters<typeof createAdvisoryValidation>[0] = {
    podRepo: { getOrThrow: get, update, hasUnansweredDecision: vi.fn(() => state.unanswered) },
    nudgeRepo: { hasPending: vi.fn(() => state.pending) },
    validationRepo: { isLatestForPod: vi.fn(() => state.latest), updateAdvisoryResult: history },
    validationEngine: { runAdvisoryBrowserQa: runner },
    logger: { warn },
    advisoryRuns: runs,
    acquireAdvisoryQaSlot: acquire,
    releaseAdvisoryQaSlot: release,
    ...progress,
    refreshReadiness: readiness,
    emitActivityStatus: activity,
  };
  const owner = createAdvisoryValidation(deps);
  const blocking = pod.lastValidationResult;
  if (!blocking) throw new Error('Missing fixture result');
  const cfg = config();
  return {
    state,
    repository,
    pod,
    blocking,
    cfg,
    trace,
    runs,
    event,
    runner,
    get,
    update,
    history,
    readiness,
    acquire,
    release,
    warn,
    activity,
    deps,
    owner,
    run: (id: string | undefined = 'history-1') =>
      owner.runAdvisoryAfterValidation(pod.id, cfg, blocking, id, pod),
    ownership: (owns?: () => boolean, id: string | undefined = 'history-1') =>
      owner.advisoryPublicationOwnership(pod, blocking, id, owns),
  };
}

describe('advisory validation ownership contract', () => {
  it('uses a replacement advisory method and its receiver after a queued slot', async () => {
    const f = fixture();
    const slot = deferred<void>();
    f.acquire.mockImplementation(() => slot.promise);
    const engine = f.deps.validationEngine;
    const replacement = vi.fn<Runner>(async function (this: typeof engine) {
      expect(this).toBe(engine);
      return qa();
    });
    const pending = f.run();
    engine.runAdvisoryBrowserQa = replacement;
    slot.resolve();
    await expect(pending).resolves.toMatchObject({ advisoryBrowserQa: { status: 'pass' } });
    expect(replacement).toHaveBeenCalledOnce();
    expect(f.runner).not.toHaveBeenCalled();
    expect(f.release).toHaveBeenCalledOnce();
  });

  it('refuses queued advisory execution if an immutable unpublished dispatch takes custody', async () => {
    const f = fixture();
    f.repository.update(f.pod.id, { containerId: null });
    f.repository.update(f.pod.id, {
      executionTarget: 'sandbox',
      containerId: '11111111-1111-4111-8111-111111111111',
    });
    Object.assign(f.pod, f.repository.getOrThrow(f.pod.id));
    Object.assign(f.state.pod, f.pod);
    const queued = deferred<void>();
    f.acquire.mockImplementation(() => queued.promise);
    const pending = f.run();
    const retries = f.repository.taskRetries;
    const ledger = f.repository.validationExecutions;
    if (!retries || !ledger) throw new Error('Missing durable validation ledger');
    Object.assign(f.deps.podRepo, { validationExecutions: ledger });
    const identity = {
      source: 'a'.repeat(64),
      contract: 'b'.repeat(64),
      commands: 'c'.repeat(64),
      environment: null,
      implementation: null,
    };
    const admission = retries.admit(
      f.pod.id,
      f.pod.lifecycleGeneration,
      identity,
      'd'.repeat(64),
      [],
    );
    retries.start(admission.id);
    expect(ledger.dispatch(f.pod, admission.id, 1, 'test-scope')).not.toBeNull();
    queued.resolve();
    await expect(pending).rejects.toBeInstanceOf(ValidationSupersededError);
    expect(f.runner).not.toHaveBeenCalled();
    expect(f.history).not.toHaveBeenCalled();
  });

  it('constructs inertly and returns the actual current pod when ownership is valid', () => {
    const f = fixture();
    expect(f.get).not.toHaveBeenCalled();
    expect(f.runner).not.toHaveBeenCalled();
    expect(f.trace).toEqual([]);
    expect(f.runs.size).toBe(0);
    expect(f.ownership().assertCurrent()).toBe(f.state.pod);
  });
  it.each([
    ['generation', { lifecycleGeneration: 99 }],
    ['container', { containerId: 'replacement' }],
    ['target', { executionTarget: 'sandbox' }],
    ['worktree', { worktreePath: '/new' }],
    ['branch', { branch: 'replacement' }],
    ['base', { baseBranch: 'other' }],
    ['runtime', { runtime: 'codex' }],
    ['model', { model: 'other' }],
    ['provider', { providerIdSnapshot: 'openai' }],
    ['account', { providerAccountIdSnapshot: 'other' }],
    ['profile', { profileSnapshot: { name: 'other' } }],
    ['contract', { contract: { task: 'other' } }],
    ['options', { options: { advisoryBrowserQaEnabled: false } }],
    ['status', { status: 'running' }],
  ] as const)('rejects a changed %s identity', (_name, change) => {
    const f = fixture();
    const ownership = f.ownership();
    Object.assign(f.state.pod, change);
    expect(ownership.isCurrent()).toBe(false);
    expect(() => ownership.assertCurrent()).toThrow(ValidationSupersededError);
  });
  it.each(['attempt', 'history', 'invocation', 'nudge', 'decision', 'deleted'] as const)(
    'rejects %s supersession',
    (kind) => {
      const f = fixture();
      const ownership = f.ownership(() => kind !== 'invocation');
      if (kind === 'attempt') f.state.pod.lastValidationResult = { ...f.blocking, attempt: 2 };
      if (kind === 'history') f.state.latest = false;
      if (kind === 'nudge') f.state.pending = true;
      if (kind === 'decision') f.state.unanswered = true;
      if (kind === 'deleted')
        f.get.mockImplementation(() => {
          throw new Error('Missing');
        });
      expect(ownership.isCurrent()).toBe(false);
      expect(() => ownership.assertCurrent()).toThrow(ValidationSupersededError);
    },
  );
  it('catches an attempt lookup failure after the initial current-pod read', () => {
    const f = fixture();
    f.get.mockReturnValueOnce(f.state.pod).mockImplementationOnce(() => {
      throw new Error('Read failed');
    });
    expect(f.ownership().isCurrent()).toBe(false);
  });
  it.each(['absent-id', 'absent-repository'] as const)('keeps the %s history bypass', (mode) => {
    const f = fixture();
    f.state.latest = false;
    if (mode === 'absent-repository') f.deps.validationRepo = undefined;
    const owner = createAdvisoryValidation(f.deps);
    expect(
      owner
        .advisoryPublicationOwnership(
          f.pod,
          f.blocking,
          mode === 'absent-id' ? undefined : 'history',
        )
        .isCurrent(),
    ).toBe(true);
  });
  it.each(['absent', 'nullish', 'false'] as const)(
    'uses the pending escalation fallback only for %s unanswered support',
    (mode) => {
      const f = fixture();
      f.state.pod.pendingEscalation = {
        id: 'decision',
        podId: f.pod.id,
        type: 'ask_human',
        timestamp: '2026-10-18T12:00:00Z',
        payload: { question: 'Keep decision pending' },
        response: null,
      };
      if (mode === 'absent') f.deps.podRepo.hasUnansweredDecision = undefined;
      if (mode === 'nullish')
        Object.assign(f.deps.podRepo, { hasUnansweredDecision: () => undefined });
      expect(f.ownership().isCurrent()).toBe(mode === 'false');
    },
  );
});

describe('advisory validation execution contract', () => {
  it('returns identical blocking evidence without checking ownership when the optional method is absent', async () => {
    const f = fixture();
    f.deps.validationEngine.runAdvisoryBrowserQa = undefined;
    f.state.pending = true;
    expect(await f.run()).toBe(f.blocking);
    expect(f.trace).toEqual([]);
    expect(f.get).not.toHaveBeenCalled();
  });
  it('checks initial ownership before progress, slot acquisition or registry registration', async () => {
    const f = fixture();
    f.state.pending = true;
    await expect(f.run()).rejects.toThrow(ValidationSupersededError);
    expect(f.trace).toEqual([]);
    expect(f.runs.size).toBe(0);
  });
  it('stores the inner promise and preserves exact launch arguments and engine receiver', async () => {
    const f = fixture();
    const hold = deferred<Advisory>();
    f.runner.mockImplementation(function (
      this: unknown,
      cfg,
      blocking,
      progress,
      signal,
      callbacks,
    ) {
      expect(this).toBe(f.deps.validationEngine);
      expect(cfg).toBe(f.cfg);
      expect(blocking).toBe(f.blocking);
      expect(signal).toBeUndefined();
      expect(callbacks?.onPhaseStarted).toBeTypeOf('function');
      expect(callbacks?.onReviewProgress).toBeTypeOf('function');
      progress?.('Running QA');
      return hold.promise;
    });
    const operation = f.run();
    const inner = f.runs.get(f.pod.id);
    expect(inner).toBeInstanceOf(Promise);
    expect(inner).not.toBe(operation);
    try {
      await Promise.resolve();
      expect(f.runner).toHaveBeenCalledOnce();
      expect(f.activity.mock.calls.map(([, message]) => message)).toEqual([
        'Waiting for advisory browser QA slot…',
        'Running QA',
      ]);
      hold.resolve(qa());
      await operation;
      expect(f.runs.size).toBe(0);
      expect(f.release).toHaveBeenCalledOnce();
    } finally {
      hold.resolve(qa());
      await operation.catch(() => {});
    }
  });
  it('does not release an unacquired slot after acquisition rejection', async () => {
    const f = fixture();
    const error = new Error('Slot failed');
    f.acquire.mockRejectedValueOnce(error);
    expect(await f.run()).toBe(f.blocking);
    expect(f.release).not.toHaveBeenCalled();
    expect(f.runner).not.toHaveBeenCalled();
    expect(f.warn).toHaveBeenCalledWith(
      { err: error, podId: f.pod.id },
      'Advisory browser QA failed after validation',
    );
    expect(f.runs.size).toBe(0);
  });
  it('releases an acquired slot without launching queued stale work', async () => {
    const f = fixture();
    const hold = deferred<void>();
    f.acquire.mockImplementationOnce(() => hold.promise);
    const operation = f.run();
    const rejection = expect(operation).rejects.toThrow(ValidationSupersededError);
    f.state.pod.lifecycleGeneration++;
    hold.resolve();
    await rejection;
    expect(f.release).toHaveBeenCalledOnce();
    expect(f.runner).not.toHaveBeenCalled();
    expect(f.warn).not.toHaveBeenCalled();
    expect(f.runs.size).toBe(0);
  });
  it.each(['null', 'failure'] as const)(
    'returns the same blocking result for current %s completion',
    async (mode) => {
      const f = fixture();
      const error = new Error('Engine failed');
      if (mode === 'null') f.runner.mockResolvedValueOnce(null);
      else f.runner.mockRejectedValueOnce(error);
      expect(await f.run()).toBe(f.blocking);
      expect(f.release).toHaveBeenCalledOnce();
      expect(f.history).not.toHaveBeenCalled();
      expect(f.update).not.toHaveBeenCalled();
      expect(f.warn).toHaveBeenCalledTimes(mode === 'failure' ? 1 : 0);
      expect(f.runs.size).toBe(0);
    },
  );
  it.each(['null', 'failure'] as const)(
    'propagates stale ownership after superseded %s completion',
    async (mode) => {
      const f = fixture();
      f.runner.mockImplementationOnce(async () => {
        f.state.pending = true;
        if (mode === 'failure') throw new Error('Engine failed');
        return null;
      });
      await expect(f.run()).rejects.toThrow(ValidationSupersededError);
      expect(f.release).toHaveBeenCalledOnce();
      expect(f.warn).not.toHaveBeenCalled();
      expect(f.runs.size).toBe(0);
    },
  );
  it('merges callback evidence before emitting and preserves duplicate final writes and usage', async () => {
    const f = fixture();
    const value = qa();
    const observations: unknown[] = [];
    f.event.mockImplementation(() => {
      observations.push(f.state.pod.lastValidationResult?.advisoryBrowserQa);
      f.trace.push('event');
      return 1;
    });
    f.runner.mockImplementationOnce(async (_cfg, _blocking, _progress, _signal, callbacks) => {
      callbacks?.onPhaseCompleted?.('advisory', 'pass', value);
      return value;
    });
    const final = await f.run();
    expect(observations).toEqual([value]);
    expect(final).toEqual({ ...f.blocking, advisoryBrowserQa: value });
    expect(final).toBe(f.state.pod.lastValidationResult);
    expect(f.trace).toEqual([
      'activity',
      'acquire',
      'history',
      'live',
      'readiness',
      'event',
      'release',
      'usage',
      'history',
      'live',
      'readiness',
    ]);
    expect(f.history).toHaveBeenNthCalledWith(1, f.pod.id, 'history-1', value);
    expect(f.history).toHaveBeenCalledTimes(2);
    expect(f.readiness).toHaveBeenCalledTimes(2);
    expect(f.readiness).toHaveBeenCalledWith(f.pod.id, { advisoryQaInFlight: false });
    expect(f.state.pod.phaseTokenUsage?.advisory).toEqual(value.tokenUsage);
  });
  it('forwards other phase/review callbacks but ignores falsey advisory phase evidence', async () => {
    const f = fixture();
    f.runner.mockImplementationOnce(async (_cfg, _blocking, _progress, _signal, callbacks) => {
      callbacks?.onPhaseStarted?.('build');
      callbacks?.onPhaseCompleted?.('build', 'pass', f.blocking.smoke.build);
      callbacks?.onPhaseCompleted?.('advisory', 'skip', undefined);
      return null;
    });
    expect(await f.run()).toBe(f.blocking);
    expect(f.event).toHaveBeenCalledTimes(3);
    expect(f.history).not.toHaveBeenCalled();
    expect(f.readiness).not.toHaveBeenCalled();
  });
  it('retains historical evidence and cumulative usage while suppressing stale progress and publication', async () => {
    const f = fixture();
    const value = qa();
    const replacement = { ...f.blocking, attempt: 2 };
    f.runner.mockImplementationOnce(async (_cfg, _blocking, progress, _signal, callbacks) => {
      f.state.pod.lastValidationResult = replacement;
      f.state.latest = false;
      progress?.('Old progress');
      callbacks?.onPhaseStarted?.('advisory');
      callbacks?.onPhaseCompleted?.('advisory', 'pass', value);
      return value;
    });
    await expect(f.run()).rejects.toThrow(ValidationSupersededError);
    expect(f.history).toHaveBeenCalledTimes(2);
    expect(f.state.pod.phaseTokenUsage?.advisory).toEqual(value.tokenUsage);
    expect(f.state.pod.lastValidationResult).toBe(replacement);
    expect(f.readiness).not.toHaveBeenCalled();
    expect(f.event).not.toHaveBeenCalled();
    expect(f.activity).toHaveBeenCalledOnce();
    expect(f.release).toHaveBeenCalledOnce();
    expect(f.runs.size).toBe(0);
  });
  it.each(['callback-history', 'final-history', 'usage'] as const)(
    'retains prior effects and error timing for %s failure',
    async (mode) => {
      const f = fixture();
      const error = new Error(mode);
      const value = qa();
      if (mode === 'usage')
        f.update.mockImplementationOnce(() => {
          throw error;
        });
      else
        f.history.mockImplementationOnce(() => {
          throw error;
        });
      f.runner.mockImplementationOnce(async (_cfg, _blocking, _progress, _signal, callbacks) => {
        if (mode === 'callback-history') callbacks?.onPhaseCompleted?.('advisory', 'pass', value);
        return value;
      });
      if (mode === 'callback-history') {
        expect(await f.run()).toBe(f.blocking);
        expect(f.warn).toHaveBeenCalledOnce();
        expect(f.update).not.toHaveBeenCalled();
      } else {
        await expect(f.run()).rejects.toBe(error);
        expect(f.warn).not.toHaveBeenCalled();
        expect(f.update).toHaveBeenCalledTimes(1);
      }
      expect(f.release).toHaveBeenCalledOnce();
      expect(f.runs.size).toBe(0);
      if (mode === 'final-history')
        expect(f.state.pod.phaseTokenUsage?.advisory).toEqual(value.tokenUsage);
      if (mode === 'usage') expect(f.history).not.toHaveBeenCalled();
    },
  );
  it('swallows a current completed-event callback failure only after its persistence effects', async () => {
    const f = fixture();
    const error = new Error('Event failed');
    const value = qa();
    f.event.mockImplementationOnce(() => {
      throw error;
    });
    f.runner.mockImplementationOnce(async (_cfg, _blocking, _progress, _signal, callbacks) => {
      callbacks?.onPhaseCompleted?.('advisory', 'pass', value);
      return value;
    });
    expect(await f.run()).toBe(f.blocking);
    expect(f.state.pod.lastValidationResult?.advisoryBrowserQa).toBe(value);
    expect(f.history).toHaveBeenCalledOnce();
    expect(f.readiness).toHaveBeenCalledOnce();
    expect(f.state.pod.phaseTokenUsage).toBeNull();
    expect(f.warn).toHaveBeenCalledOnce();
    expect(f.release).toHaveBeenCalledOnce();
  });
  it.each([0, 2] as const)(
    'adds usage and retains optional cached/cost keys only for positive totals (%s)',
    async (optional) => {
      const f = fixture();
      f.state.pod.phaseTokenUsage = {
        agent_initial: { inputTokens: 7, outputTokens: 1 },
        advisory: { inputTokens: 4, outputTokens: 2 },
      };
      const value = qa();
      value.tokenUsage = {
        inputTokens: 3,
        outputTokens: 5,
        cachedInputTokens: optional,
        costUsd: optional,
      };
      f.runner.mockResolvedValueOnce(value);
      await f.run();
      expect(f.state.pod.phaseTokenUsage).toEqual({
        agent_initial: { inputTokens: 7, outputTokens: 1 },
        advisory: {
          inputTokens: 7,
          outputTokens: 7,
          ...(optional > 0 ? { cachedInputTokens: optional, costUsd: optional } : {}),
        },
      });
    },
  );
  it('adds prior cached/cost usage and does not write usage when it was not reported', async () => {
    const f = fixture();
    f.state.pod.phaseTokenUsage = {
      advisory: { inputTokens: 1, outputTokens: 2, cachedInputTokens: 4, costUsd: 1 },
    };
    const value = qa();
    f.runner.mockResolvedValueOnce(value);
    await f.run();
    expect(f.state.pod.phaseTokenUsage?.advisory).toEqual({
      inputTokens: 12,
      outputTokens: 5,
      cachedInputTokens: 6,
      costUsd: 1.02,
    });
    const { tokenUsage: _usage, ...withoutUsage } = value;
    f.runner.mockResolvedValueOnce(withoutUsage);
    f.update.mockClear();
    await f.run();
    expect(f.update).toHaveBeenCalledOnce();
    expect(f.update.mock.calls[0]?.[1]).toHaveProperty('lastValidationResult');
  });
  it('uses the original pre-history current-read timing at final merge', async () => {
    const f = fixture();
    const readSnapshot = {
      ...f.state.pod,
      lastValidationResult: { ...f.blocking, reviewSkipReason: 'Before history write' },
    };
    f.get.mockImplementation(() => readSnapshot);
    f.history.mockImplementation(() => {
      f.state.pod = {
        ...readSnapshot,
        lastValidationResult: { ...f.blocking, reviewSkipReason: 'After history write' },
      };
      return true;
    });
    const final = await f.run();
    expect(final.reviewSkipReason).toBe('Before history write');
  });
  it('does not delete a newer same-pod registry entry when an old run settles', async () => {
    const f = fixture();
    const first = deferred<Advisory>();
    const second = deferred<Advisory>();
    f.runner
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
    const old = f.run();
    const stale = expect(old).rejects.toThrow(ValidationSupersededError);
    await Promise.resolve();
    const replacement = f.run();
    const replacementInner = f.runs.get(f.pod.id);
    await Promise.resolve();
    try {
      first.resolve(qa());
      await stale;
      expect(f.runs.get(f.pod.id)).toBe(replacementInner);
      second.resolve(qa());
      await replacement;
      expect(f.runs.size).toBe(0);
      expect(f.release).toHaveBeenCalledTimes(2);
    } finally {
      first.resolve(qa());
      second.resolve(qa());
      await Promise.allSettled([old, replacement]);
    }
  });
  it.each(['replace', 'remove'] as const)(
    'keeps the live optional method lookup after the slot wait (%s)',
    async (mode) => {
      const f = fixture();
      const hold = deferred<void>();
      f.acquire.mockImplementationOnce(() => hold.promise);
      const next = vi.fn<Runner>(async function (this: unknown) {
        expect(this).toBe(f.deps.validationEngine);
        return null;
      });
      const operation = f.run();
      f.deps.validationEngine.runAdvisoryBrowserQa = mode === 'replace' ? next : undefined;
      hold.resolve();
      expect(await operation).toBe(f.blocking);
      expect(f.runner).not.toHaveBeenCalled();
      expect(next).toHaveBeenCalledTimes(mode === 'replace' ? 1 : 0);
      expect(f.warn).toHaveBeenCalledTimes(mode === 'remove' ? 1 : 0);
      expect(f.release).toHaveBeenCalledOnce();
    },
  );
  it.each([false, true])(
    'forwards review progress only while current (stale=%s)',
    async (stale) => {
      const f = fixture();
      const review = {
        attempt: 1,
        startedAt: '2026-10-18T12:00:00Z',
        updatedAt: '2026-10-18T12:00:01Z',
        elapsedMs: 1000,
        guardrailMs: 5000,
        stage: 'axes' as const,
        axes: [],
      };
      f.runner.mockImplementationOnce(async (_cfg, _blocking, _progress, _signal, callbacks) => {
        f.state.pending = stale;
        callbacks?.onReviewProgress?.(review);
        return null;
      });
      if (stale) await expect(f.run()).rejects.toThrow(ValidationSupersededError);
      else expect(await f.run()).toBe(f.blocking);
      expect(f.event).toHaveBeenCalledTimes(stale ? 0 : 1);
      if (!stale)
        expect(f.event).toHaveBeenCalledWith({
          type: 'pod.review_progress',
          timestamp: review.updatedAt,
          podId: f.pod.id,
          progress: review,
        });
      expect(f.release).toHaveBeenCalledOnce();
    },
  );
  it.each(['id', 'repository'] as const)(
    'runs without optional history %s and skips persistence',
    async (missing) => {
      const f = fixture();
      if (missing === 'repository') f.deps.validationRepo = undefined;
      const owner = createAdvisoryValidation(f.deps);
      const value = qa();
      f.runner.mockResolvedValueOnce(value);
      expect(
        await owner.runAdvisoryAfterValidation(
          f.pod.id,
          f.cfg,
          f.blocking,
          missing === 'id' ? undefined : 'history',
          f.pod,
        ),
      ).toEqual({ ...f.blocking, advisoryBrowserQa: value });
      expect(f.history).not.toHaveBeenCalled();
      expect(f.state.pod.phaseTokenUsage?.advisory).toEqual(value.tokenUsage);
      expect(f.readiness).toHaveBeenCalledOnce();
    },
  );
  it('keeps callback evidence when the engine ultimately returns null without adding final usage', async () => {
    const f = fixture();
    const value = qa();
    f.runner.mockImplementationOnce(async (_cfg, _blocking, _progress, _signal, callbacks) => {
      callbacks?.onPhaseCompleted?.('advisory', 'pass', value);
      return null;
    });
    expect(await f.run()).toBe(f.blocking);
    expect(f.state.pod.lastValidationResult?.advisoryBrowserQa).toBe(value);
    expect(f.state.pod.phaseTokenUsage).toBeNull();
    expect(f.history).toHaveBeenCalledOnce();
    expect(f.readiness).toHaveBeenCalledOnce();
  });
  it('captures collaborator references once instead of following wrapper replacement', async () => {
    const f = fixture();
    const replacement = vi.fn<Runner>(async () => null);
    f.deps.validationEngine = { runAdvisoryBrowserQa: replacement };
    f.deps.advisoryRuns = new Map();
    f.deps.acquireAdvisoryQaSlot = vi.fn(async () => {});
    await f.run();
    expect(f.runner).toHaveBeenCalledOnce();
    expect(replacement).not.toHaveBeenCalled();
    expect(f.acquire).toHaveBeenCalledOnce();
  });
});

function persistedFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'advisory-validation-'));
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
  cleanups.push(() => {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const podRepo = createPodRepository(db);
  const original = insertPod(podRepo);
  const waiver = {
    waivedAt: '2026-10-18T11:00:00Z',
    waivedBy: 'human',
    actor: { type: 'human' as const, userId: 'operator' },
    reason: 'Retained operator waiver',
    attempt: 1,
    failedPhases: ['review'],
    failedFactIds: [],
  };
  podRepo.update(original.id, { validationWaiver: waiver });
  const pod = podRepo.getOrThrow(original.id);
  const blocking = pod.lastValidationResult;
  if (!blocking) throw new Error('Missing result');
  const validationRepo = createValidationRepository(db);
  const record = validationRepo.insert(pod.id, 1, blocking);
  const nudges = createNudgeRepository(db);
  const events = createEventRepository(db);
  const bus = createEventBus(events, logger);
  const progress = createValidationProgress({ eventBus: bus });
  const readiness = createReadinessService({ podRepo, validationRepo, eventRepo: events });
  const runner = vi.fn<Runner>();
  const refresh = vi.fn((id: string, options?: { advisoryQaInFlight?: boolean }) => {
    readiness.refreshPodReadiness(id, options);
    return true;
  });
  const owner = createAdvisoryValidation({
    podRepo,
    nudgeRepo: nudges,
    validationRepo,
    validationEngine: { runAdvisoryBrowserQa: runner },
    logger,
    advisoryRuns: new Map(),
    acquireAdvisoryQaSlot: async () => {},
    releaseAdvisoryQaSlot: () => {},
    ...progress,
    refreshReadiness: refresh,
    emitActivityStatus: () => {},
  });
  const rows = () => ({
    pods: db.prepare('SELECT * FROM pods ORDER BY id').all(),
    validations: db.prepare('SELECT * FROM validations ORDER BY sequence').all(),
    events: db.prepare('SELECT * FROM events ORDER BY rowid').all(),
    nudges: db.prepare('SELECT * FROM nudge_messages ORDER BY id').all(),
    profiles: db.prepare('SELECT * FROM profiles ORDER BY name').all(),
  });
  return {
    pod,
    blocking,
    record,
    podRepo,
    validationRepo,
    nudges,
    events,
    bus,
    runner,
    refresh,
    rows,
    run: () => owner.runAdvisoryAfterValidation(pod.id, config(), blocking, record.id, pod),
    reopen() {
      const before = rows();
      db.close();
      db = new Database(file);
      db.pragma('foreign_keys = ON');
      expect(db.pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }]);
      expect(db.pragma('foreign_key_check')).toEqual([]);
      expect(rows()).toEqual(before);
      expect(createPodRepository(db).getOrThrow(pod.id).validationWaiver).toEqual(waiver);
      return {
        pod: createPodRepository(db).getOrThrow(pod.id),
        validations: createValidationRepository(db).getForSession(pod.id),
        events: createEventRepository(db).getForSession(pod.id),
        nudges: createNudgeRepository(db).listPending(pod.id),
      };
    },
  };
}

describe('advisory validation real local repository and reopen integration', () => {
  it('persists current QA, additive usage, readiness and merged evidence before subscribers observe completion', async () => {
    const f = persistedFixture();
    const profiles = f.rows().profiles;
    const value = qa();
    const seen: unknown[] = [];
    f.podRepo.update(f.pod.id, {
      phaseTokenUsage: {
        agent_initial: { inputTokens: 7, outputTokens: 2 },
        advisory: { inputTokens: 1, outputTokens: 1 },
      },
    });
    f.bus.subscribe(() => {
      seen.push({
        live: f.podRepo.getOrThrow(f.pod.id).lastValidationResult?.advisoryBrowserQa,
        history: f.validationRepo.getLatest(f.pod.id)?.result.advisoryBrowserQa,
      });
    });
    f.runner.mockImplementationOnce(async (_cfg, _blocking, _progress, _signal, callbacks) => {
      const retained = { ...f.blocking, reviewSkipReason: 'Waiver retained while QA waited' };
      f.validationRepo.updateResult(f.record.id, retained);
      f.podRepo.update(f.pod.id, { lastValidationResult: retained });
      callbacks?.onPhaseCompleted?.('advisory', 'pass', value);
      return value;
    });
    await f.run();
    expect(seen).toEqual([{ live: value, history: value }]);
    expect(f.refresh).toHaveBeenCalledTimes(2);
    expect(f.rows().profiles).toEqual(profiles);
    const reopened = f.reopen();
    expect(reopened.validations[0]).toMatchObject({
      id: f.record.id,
      result: {
        overall: 'pass',
        reviewSkipReason: 'Waiver retained while QA waited',
        advisoryBrowserQa: value,
      },
    });
    expect(reopened.pod.lastValidationResult).toEqual(reopened.validations[0]?.result);
    expect(reopened.pod.phaseTokenUsage).toEqual({
      agent_initial: { inputTokens: 7, outputTokens: 2 },
      advisory: { inputTokens: 12, outputTokens: 4, cachedInputTokens: 2, costUsd: 0.02 },
    });
    expect(reopened.pod.readinessReview?.areas).toContainEqual(
      expect.objectContaining({ area: 'advisory_qa', status: 'ready' }),
    );
    expect(reopened.events).toHaveLength(1);
    expect(reopened.events[0]?.payload).toMatchObject({
      type: 'pod.validation_phase_completed',
      phase: 'advisory',
      advisoryResult: value,
    });
  });
  it('retains old exact history and spend across newer same-attempt history without overwriting replacement evidence', async () => {
    const f = persistedFixture();
    const value = qa();
    const replacement = { ...f.blocking, reviewSkipReason: 'Replacement evidence' };
    let latestId = '';
    f.runner.mockImplementationOnce(async (_cfg, _blocking, _progress, _signal, callbacks) => {
      latestId = f.validationRepo.insert(f.pod.id, 1, replacement).id;
      f.podRepo.update(f.pod.id, { lastValidationResult: replacement });
      callbacks?.onPhaseCompleted?.('advisory', 'pass', value);
      return value;
    });
    await expect(f.run()).rejects.toThrow(ValidationSupersededError);
    expect(f.refresh).not.toHaveBeenCalled();
    const reopened = f.reopen();
    expect(reopened.validations).toHaveLength(2);
    expect(reopened.validations[0]).toMatchObject({
      id: f.record.id,
      result: { ...f.blocking, advisoryBrowserQa: value },
    });
    expect(reopened.validations[1]).toMatchObject({ id: latestId, result: replacement });
    expect(reopened.pod.lastValidationResult).toEqual(replacement);
    expect(reopened.pod.phaseTokenUsage?.advisory).toEqual(value.tokenUsage);
    expect(reopened.events).toHaveLength(0);
  });
  it('retains the queued human decision and original blocking result while persisting old advisory history and usage', async () => {
    const f = persistedFixture();
    const value = qa();
    f.runner.mockImplementationOnce(async (_cfg, _blocking, progress, _signal, callbacks) => {
      f.nudges.queue(f.pod.id, 'Human decision stays pending');
      progress?.('Obsolete progress');
      callbacks?.onPhaseStarted?.('advisory');
      callbacks?.onPhaseCompleted?.('advisory', 'pass', value);
      return value;
    });
    await expect(f.run()).rejects.toThrow(ValidationSupersededError);
    expect(f.refresh).not.toHaveBeenCalled();
    const reopened = f.reopen();
    expect(reopened.pod.lastValidationResult).toEqual(f.blocking);
    expect(reopened.pod.phaseTokenUsage?.advisory).toEqual(value.tokenUsage);
    expect(reopened.validations[0]?.result).toEqual({ ...f.blocking, advisoryBrowserQa: value });
    expect(reopened.nudges).toEqual([
      expect.objectContaining({ message: 'Human decision stays pending', consumed: false }),
    ]);
    expect(reopened.events).toHaveLength(0);
  });
});
