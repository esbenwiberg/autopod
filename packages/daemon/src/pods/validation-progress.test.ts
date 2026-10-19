import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type {
  Pod,
  ReviewProgressSnapshot,
  SystemEvent,
  ValidationPhase,
  ValidationResult,
} from '@autopod/shared';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ValidationPhaseCallbacks } from '../interfaces/validation-engine.js';
import { createTestDb, insertTestProfile, logger } from '../test-utils/mock-helpers.js';
import { createEventBus } from './event-bus.js';
import { createEventRepository } from './event-repository.js';
import { createNudgeRepository } from './nudge-repository.js';
import { createPodRepository } from './pod-repository.js';
import { captureValidationOwnership } from './validation-ownership.js';
import { createValidationProgress } from './validation-progress.js';

const mappings = [
  ['setup', 'setupResult'],
  ['build', 'buildResult'],
  ['test', 'testResult'],
  ['lint', 'lintResult'],
  ['sast', 'sastResult'],
  ['health', 'healthResult'],
  ['pages', 'pageResults'],
  ['facts', 'factResult'],
  ['review', 'reviewResult'],
  ['advisory', 'advisoryResult'],
] as const;
const progress: ReviewProgressSnapshot = {
  attempt: 2,
  startedAt: '2000-01-01T00:00:00.000Z',
  updatedAt: '2000-01-01T00:00:03.000Z',
  elapsedMs: 3000,
  guardrailMs: 300000,
  stage: 'axes',
  axes: [],
};
const epoch = '2026-10-18T00:00:00.000Z';
const later = '2026-10-18T00:00:01.000Z';
const data: ValidationResult = {
  podId: 'worker',
  attempt: 1,
  timestamp: epoch,
  overall: 'pass',
  duration: 1,
  setup: { status: 'pass', duration: 1, output: '' },
  smoke: {
    status: 'pass',
    build: { status: 'pass', duration: 1, output: '' },
    health: { status: 'pass', duration: 1, url: '', responseCode: 200 },
    pages: [],
  },
  test: { status: 'pass', duration: 1 },
  lint: { status: 'pass', output: '', duration: 1 },
  sast: { status: 'skip', output: '', duration: 0 },
  factValidation: { status: 'pass', results: [] },
  taskReview: {
    status: 'pass',
    reasoning: '',
    issues: [],
    model: 'reviewer',
    diff: '',
    screenshots: [],
  },
  advisoryBrowserQa: {
    status: 'pass',
    reasoning: '',
    observations: [],
    screenshots: [],
    durationMs: 1,
  },
};
const payloads: Record<ValidationPhase, unknown> = {
  setup: data.setup,
  build: data.smoke.build,
  test: data.test,
  lint: data.lint,
  sast: data.sast,
  health: data.smoke.health,
  pages: data.smoke.pages,
  facts: data.factValidation,
  review: data.taskReview,
  advisory: data.advisoryBrowserQa,
};
type Kind = 'start' | 'complete' | 'review';
const kinds: Kind[] = ['start', 'complete', 'review'];
function invoke(callbacks: ValidationPhaseCallbacks, kind: Kind) {
  if (kind === 'start') return callbacks.onPhaseStarted?.('test');
  if (kind === 'complete')
    return callbacks.onPhaseCompleted?.('test', 'pending_human', payloads.test);
  return callbacks.onReviewProgress?.(progress);
}
function ownership() {
  return {
    isCurrent: vi.fn(() => true),
    assertCurrent: vi.fn<() => Pod>(() => {
      throw new Error('Unexpected assertCurrent');
    }),
  };
}
function memoryFixture() {
  const events: SystemEvent[] = [];
  const bus = {
    emit: vi.fn((event: SystemEvent) => {
      events.push(event);
      return events.length;
    }),
  };
  const deps = { eventBus: bus };
  return { events, bus, deps, op: createValidationProgress(deps) };
}
function caught(run: () => void): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error('Expected synchronous throw');
}
const cleanup: Array<() => void> = [];
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  for (const close of cleanup.splice(0).reverse()) close();
});

describe('validation progress event contracts', () => {
  it('constructs factories/builders/wrappers without event, clock or ownership effects', () => {
    const clock = vi.spyOn(globalThis, 'Date');
    const f = memoryFixture();
    const owner = ownership();
    const a = f.op.buildPhaseEventCallbacks('a');
    const b = f.op.buildPhaseEventCallbacks('b');
    const c = f.op.ownedValidationCallbacks(owner, a);
    const d = f.op.ownedValidationCallbacks(owner, undefined);
    expect(f.bus.emit).not.toHaveBeenCalled();
    expect(clock).not.toHaveBeenCalled();
    expect(owner.isCurrent).not.toHaveBeenCalled();
    expect(owner.assertCurrent).not.toHaveBeenCalled();
    expect(a).not.toBe(b);
    expect(c).not.toBe(d);
    for (const key of ['onPhaseStarted', 'onPhaseCompleted', 'onReviewProgress'] as const) {
      expect(a[key]).not.toBe(b[key]);
      expect(c[key]).toBeTypeOf('function');
      expect(c[key]).not.toBe(d[key]);
    }
  });
  it.each(
    mappings.flatMap(([phase, key]) =>
      (['pass', 'fail', 'skip', 'pending_human'] as const).map((status) => ({
        phase,
        key,
        status,
      })),
    ),
  )(
    '$phase forwards $status independently of its payload with invocation-time envelopes',
    ({ phase, key, status }) => {
      vi.useFakeTimers();
      vi.setSystemTime(epoch);
      const f = memoryFixture();
      const callbacks = f.op.buildPhaseEventCallbacks('captured');
      vi.setSystemTime(later);
      expect(callbacks.onPhaseStarted(phase)).toBeUndefined();
      expect(callbacks.onPhaseCompleted(phase, status, payloads[phase])).toBeUndefined();
      expect(f.events).toEqual([
        { type: 'pod.validation_phase_started', timestamp: later, podId: 'captured', phase },
        {
          type: 'pod.validation_phase_completed',
          timestamp: later,
          podId: 'captured',
          phase,
          phaseStatus: status,
          [key]: payloads[phase],
        },
      ]);
      const completed = f.events[1];
      if (!completed) throw new Error('Missing completion');
      expect(Reflect.get(completed, key)).toBe(payloads[phase]);
      callbacks.onPhaseCompleted(phase, status, payloads[phase]);
      expect(f.events[2]).not.toBe(completed);
      expect(f.events[2]).toEqual(completed);
    },
  );
  it('isolates captured pod IDs and forwards the same review snapshot using updatedAt', () => {
    vi.useFakeTimers();
    vi.setSystemTime(epoch);
    const f = memoryFixture();
    f.op.buildPhaseEventCallbacks('first').onReviewProgress(progress);
    f.op.buildPhaseEventCallbacks('second').onReviewProgress(progress);
    expect(f.events).toEqual(
      ['first', 'second'].map((podId) => ({
        type: 'pod.review_progress',
        podId,
        timestamp: progress.updatedAt,
        progress,
      })),
    );
    const event = f.events[0];
    if (!event || event.type !== 'pod.review_progress') throw new Error('Missing review');
    expect(event.progress).toBe(progress);
  });
  it.each(mappings)('%s retains an explicit undefined live payload under %s', (phase, key) => {
    const f = memoryFixture();
    f.op.buildPhaseEventCallbacks('worker').onPhaseCompleted(phase, 'skip', undefined);
    const event = f.events[0];
    if (!event) throw new Error('Missing event');
    expect(Object.hasOwn(event, key)).toBe(true);
    expect(Reflect.get(event, key)).toBeUndefined();
  });
  it.each(mappings.filter(([phase]) => ['facts', 'review', 'advisory'].includes(phase)))(
    '%s retains null under %s',
    (phase, key) => {
      const f = memoryFixture();
      f.op.buildPhaseEventCallbacks('worker').onPhaseCompleted(phase, 'skip', null);
      expect(f.events).toEqual([expect.objectContaining({ [key]: null })]);
    },
  );
  it('forwards arbitrary unknown payloads without normalization and keeps empty pages', () => {
    const f = memoryFixture();
    const c = f.op.buildPhaseEventCallbacks('worker');
    const arbitrary = { anything: ['unvalidated'] };
    const pages: unknown[] = [];
    c.onPhaseCompleted('build', 'pass', arbitrary);
    c.onPhaseCompleted('pages', 'skip', pages);
    expect(Reflect.get(f.events[0] ?? {}, 'buildResult')).toBe(arbitrary);
    expect(Reflect.get(f.events[1] ?? {}, 'pageResults')).toBe(pages);
  });
  it('forwards an unknown runtime start phase but emits no unknown completion fallback', () => {
    const f = memoryFixture();
    const c = f.op.buildPhaseEventCallbacks('worker');
    const phase = 'future-phase' as ValidationPhase;
    c.onPhaseStarted(phase);
    c.onPhaseCompleted(phase, 'pass', {});
    expect(f.events).toEqual([
      expect.objectContaining({ type: 'pod.validation_phase_started', phase }),
    ]);
  });
  it('captures the original bus object and looks up its replaced emit method at invocation', () => {
    const f = memoryFixture();
    const callback = f.op.buildPhaseEventCallbacks('worker');
    f.deps.eventBus = { emit: vi.fn(() => 999) };
    const replacement = vi.fn(() => 37);
    f.bus.emit = replacement;
    callback.onPhaseStarted('build');
    expect(replacement).toHaveBeenCalledOnce();
    expect(f.deps.eventBus.emit).not.toHaveBeenCalled();
  });
  it.each(kinds)('%s preserves synchronous bus-error identity', (kind) => {
    const f = memoryFixture();
    const error = new Error('Bus failed');
    f.bus.emit.mockImplementation(() => {
      throw error;
    });
    expect(caught(() => invoke(f.op.buildPhaseEventCallbacks('worker'), kind))).toBe(error);
  });
});

describe('owned validation callback forwarding', () => {
  it.each(kinds)(
    '%s checks current ownership each time, preserves arguments and method receiver',
    (kind) => {
      const f = memoryFixture();
      const owner = ownership();
      const receivers: unknown[] = [];
      const args: unknown[][] = [];
      const handler = vi.fn(function (this: ValidationPhaseCallbacks, ...values: unknown[]) {
        receivers.push(this);
        args.push(values);
        return 99;
      });
      const callbacks = {
        onPhaseStarted: handler,
        onPhaseCompleted: handler,
        onReviewProgress: handler,
      };
      const wrapped = f.op.ownedValidationCallbacks(owner, callbacks);
      expect(invoke(wrapped, kind)).toBeUndefined();
      owner.isCurrent.mockReturnValue(false);
      invoke(wrapped, kind);
      owner.isCurrent.mockReturnValue(true);
      invoke(wrapped, kind);
      expect(owner.isCurrent).toHaveBeenCalledTimes(3);
      expect(owner.assertCurrent).not.toHaveBeenCalled();
      expect(handler).toHaveBeenCalledTimes(2);
      expect(receivers).toEqual([callbacks, callbacks]);
      const expected =
        kind === 'start'
          ? ['test']
          : kind === 'complete'
            ? ['test', 'pending_human', payloads.test]
            : [progress];
      expect(args).toEqual([expected, expected]);
      if (kind !== 'start')
        expect(args[0]?.[kind === 'complete' ? 2 : 0]).toBe(
          kind === 'complete' ? payloads.test : progress,
        );
    },
  );
  it.each([undefined, {}])(
    'checks ownership even when the captured callbacks are %s',
    (callbacks) => {
      const f = memoryFixture();
      const owner = ownership();
      const wrapped = f.op.ownedValidationCallbacks(owner, callbacks);
      kinds.forEach((kind) => expect(invoke(wrapped, kind)).toBeUndefined());
      expect(owner.isCurrent).toHaveBeenCalledTimes(3);
    },
  );
  it.each(kinds)(
    '%s checks ownership before optional member lookup and observes changed methods',
    (kind) => {
      const f = memoryFixture();
      const owner = ownership();
      const order: string[] = [];
      const original = vi.fn();
      const replacement = vi.fn();
      const callbacks: ValidationPhaseCallbacks = {};
      const member =
        kind === 'start'
          ? 'onPhaseStarted'
          : kind === 'complete'
            ? 'onPhaseCompleted'
            : 'onReviewProgress';
      Object.defineProperty(callbacks, member, {
        configurable: true,
        get: () => {
          order.push('lookup');
          return original;
        },
      });
      const wrapped = f.op.ownedValidationCallbacks(owner, callbacks);
      owner.isCurrent.mockImplementation(() => {
        order.push('ownership');
        return false;
      });
      invoke(wrapped, kind);
      expect(order).toEqual(['ownership']);
      owner.isCurrent.mockImplementation(() => {
        order.push('ownership');
        return true;
      });
      invoke(wrapped, kind);
      expect(order).toEqual(['ownership', 'ownership', 'lookup']);
      Object.defineProperty(callbacks, member, { value: replacement });
      invoke(wrapped, kind);
      expect(original).toHaveBeenCalledOnce();
      expect(replacement).toHaveBeenCalledOnce();
    },
  );
  it('keeps captured ownership/callback objects and observes late isCurrent replacement with its receiver', () => {
    const f = memoryFixture();
    let owner = ownership();
    let callbacks: ValidationPhaseCallbacks = { onPhaseStarted: vi.fn() };
    const originalOwner = owner;
    const originalCallbacks = callbacks;
    const wrapped = f.op.ownedValidationCallbacks(owner, callbacks);
    owner = ownership();
    callbacks = { onPhaseStarted: vi.fn() };
    let receiver: unknown;
    originalOwner.isCurrent = vi.fn(function (this: typeof originalOwner) {
      receiver = this;
      return true;
    });
    wrapped.onPhaseStarted?.('build');
    expect(receiver).toBe(originalOwner);
    expect(originalCallbacks.onPhaseStarted).toHaveBeenCalledExactlyOnceWith('build');
    expect(callbacks.onPhaseStarted).not.toHaveBeenCalled();
    expect(owner.isCurrent).not.toHaveBeenCalled();
  });
  it.each(
    kinds.flatMap((kind) => (['ownership', 'callback'] as const).map((stage) => ({ kind, stage }))),
  )('$kind propagates $stage errors by identity', ({ kind, stage }) => {
    const f = memoryFixture();
    const owner = ownership();
    const error = new Error('Injected failure');
    const fail = () => {
      throw error;
    };
    const callbacks: ValidationPhaseCallbacks = {
      onPhaseStarted: fail,
      onPhaseCompleted: fail,
      onReviewProgress: fail,
    };
    if (stage === 'ownership') owner.isCurrent.mockImplementation(fail);
    expect(caught(() => invoke(f.op.ownedValidationCallbacks(owner, callbacks), kind))).toBe(error);
  });
  it('discards an asynchronous callback return without adding a scheduling boundary', async () => {
    const f = memoryFixture();
    const owner = ownership();
    let settled = false;
    const pending = Promise.resolve().then(() => {
      settled = true;
    });
    const wrapped = f.op.ownedValidationCallbacks(owner, { onPhaseStarted: () => pending });
    expect(wrapped.onPhaseStarted?.('build')).toBeUndefined();
    expect(settled).toBe(false);
    await pending;
  });
});

function diskFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'validation-progress-'));
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
  const repo = createPodRepository(db);
  repo.insert({
    id: 'worker',
    profileName: 'test-profile',
    task: 'Progress contract',
    status: 'validating',
    model: 'model',
    runtime: 'claude',
    executionTarget: 'local',
    branch: 'feature/progress',
    userId: 'operator',
    maxValidationAttempts: 3,
    skipValidation: false,
    outputMode: 'pr',
  });
  repo.update('worker', { containerId: 'container' });
  const snapshot = repo.getOrThrow('worker');
  const events = createEventRepository(db);
  const bus = createEventBus(events, logger);
  const nudges = createNudgeRepository(db);
  let invocation = true;
  const owner = captureValidationOwnership(snapshot, {
    readCurrent: () => repo.getOrThrow('worker'),
    isCurrentInvocation: () => invocation,
    hasPendingDecision: () =>
      nudges.hasPending('worker') || Boolean(repo.hasUnansweredDecision?.('worker')),
  });
  const op = createValidationProgress({ eventBus: bus });
  const raw = op.buildPhaseEventCallbacks('worker');
  const wrapped = op.ownedValidationCallbacks(owner, raw);
  return {
    repo,
    db: () => db,
    events,
    bus,
    nudges,
    owner,
    raw,
    wrapped,
    loseInvocation: () => {
      invocation = false;
    },
    reopen: () => {
      db.close();
      db = new Database(file);
      db.pragma('foreign_keys = ON');
      expect(db.pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }]);
      expect(db.pragma('foreign_key_check')).toEqual([]);
      return {
        pod: createPodRepository(db).getOrThrow('worker'),
        events: createEventRepository(db).getForSession('worker'),
      };
    },
  };
}

describe('real SQLite, event bus and validation ownership', () => {
  it('persists in order before notifying, with real IDs and JSON/reference distinctions after reopen', () => {
    const f = diskFixture();
    const live: SystemEvent[] = [];
    const counts: number[] = [];
    const unsubscribe = f.bus.subscribe((event) => {
      live.push(event);
      counts.push(f.events.getForSession('worker').length);
    });
    try {
      f.raw.onPhaseStarted('setup');
      f.raw.onPhaseCompleted('facts', 'skip', undefined);
      f.raw.onPhaseCompleted('review', 'skip', null);
      f.raw.onReviewProgress(progress);
      expect(counts).toEqual([1, 2, 3, 4]);
      expect(Reflect.get(live[1] ?? {}, 'factResult')).toBeUndefined();
      expect(Object.hasOwn(live[1] ?? {}, 'factResult')).toBe(true);
      const review = live[3];
      if (!review || review.type !== 'pod.review_progress') throw new Error('Missing progress');
      expect(review.progress).toBe(progress);
      const saved = f.reopen();
      expect(saved.events.map((row) => row.type)).toEqual([
        'pod.validation_phase_started',
        'pod.validation_phase_completed',
        'pod.validation_phase_completed',
        'pod.review_progress',
      ]);
      expect(saved.events.map((row) => row.id)).toEqual(
        live.map((event) => Reflect.get(event, '_eventId')),
      );
      expect(Object.hasOwn(saved.events[1]?.payload ?? {}, 'factResult')).toBe(false);
      expect(Reflect.get(saved.events[2]?.payload ?? {}, 'reviewResult')).toBeNull();
      expect(saved.events[3]?.payload).toEqual({
        type: 'pod.review_progress',
        timestamp: progress.updatedAt,
        podId: 'worker',
        progress,
      });
      expect(saved.pod).toMatchObject({
        status: 'validating',
        validationAttempts: 0,
        lastValidationResult: null,
      });
    } finally {
      unsubscribe();
    }
  });
  it.each([
    'generation',
    'container',
    'branch',
    'model',
    'target',
    'status',
    'decision',
    'invocation',
    'missing-row',
    'read-error',
  ])(
    'real ownership suppresses all three callbacks after %s without losing the event prefix',
    (change) => {
      const f = diskFixture();
      const notified: SystemEvent[] = [];
      const unsubscribe = f.bus.subscribe((event) => notified.push(event));
      try {
        f.wrapped.onPhaseStarted?.('setup');
        if (change === 'generation') f.repo.incrementLifecycleGeneration('worker');
        if (change === 'container') f.repo.update('worker', { containerId: 'replacement' });
        // These fields are immutable/guarded through update(); simulate persisted drift directly.
        if (change === 'branch') {
          f.db()
            .prepare('UPDATE pods SET branch = ? WHERE id = ?')
            .run('feature/replacement', 'worker');
          expect(f.repo.getOrThrow('worker').branch).toBe('feature/replacement');
        }
        if (change === 'model') f.repo.update('worker', { model: 'other-model' });
        if (change === 'target') {
          f.db()
            .prepare('UPDATE pods SET execution_target = ? WHERE id = ?')
            .run('sandbox', 'worker');
          expect(f.repo.getOrThrow('worker')).toMatchObject({
            executionTarget: 'sandbox',
            containerId: 'container',
          });
        }
        if (change === 'status') f.repo.update('worker', { status: 'running' });
        if (change === 'decision') f.nudges.queue('worker', 'New decision');
        if (change === 'invocation') f.loseInvocation();
        if (change === 'missing-row')
          vi.spyOn(f.repo, 'getOrThrow').mockImplementation(() => {
            throw new Error('Pod missing');
          });
        if (change === 'read-error')
          vi.spyOn(f.repo, 'getOrThrow').mockImplementation(() => {
            throw new Database.SqliteError('Read failed', 'SQLITE_IOERR');
          });
        for (const kind of kinds) invoke(f.wrapped, kind);
        expect(notified).toHaveLength(1);
        expect(f.owner.isCurrent()).toBe(false);
        const saved = f.reopen();
        expect(saved.events).toHaveLength(1);
        expect(saved.events[0]?.payload).toMatchObject({
          type: 'pod.validation_phase_started',
          phase: 'setup',
        });
      } finally {
        unsubscribe();
      }
    },
  );
  it('retains a durable prefix and no failed-event notification after real SQL insert abort', () => {
    const f = diskFixture();
    const notified: SystemEvent[] = [];
    const unsubscribe = f.bus.subscribe((event) => notified.push(event));
    try {
      f.wrapped.onPhaseStarted?.('setup');
      f.db().exec(
        "CREATE TRIGGER reject_completion BEFORE INSERT ON events WHEN NEW.type = 'pod.validation_phase_completed' BEGIN SELECT RAISE(ABORT, 'event rejected'); END",
      );
      const insert = f.events.insert.bind(f.events);
      let observed: unknown;
      vi.spyOn(f.events, 'insert').mockImplementation((event) => {
        try {
          return insert(event);
        } catch (error) {
          observed = error;
          throw error;
        }
      });
      const thrown = caught(() => f.wrapped.onPhaseCompleted?.('build', 'pass', data.smoke.build));
      expect(thrown).toBe(observed);
      expect(thrown).toBeInstanceOf(Database.SqliteError);
      expect(notified).toHaveLength(1);
      const saved = f.reopen();
      expect(saved.events).toHaveLength(1);
      expect(saved.pod.status).toBe('validating');
    } finally {
      unsubscribe();
    }
  });
  it('retains bus subscriber isolation with a later subscriber and durable event', () => {
    const f = diskFixture();
    const first = f.bus.subscribe(() => {
      throw new Error('Subscriber failed');
    });
    const laterEvents: SystemEvent[] = [];
    const second = f.bus.subscribe((event) => laterEvents.push(event));
    try {
      f.wrapped.onReviewProgress?.(progress);
      expect(laterEvents).toHaveLength(1);
      expect(f.reopen().events).toHaveLength(1);
    } finally {
      second();
      first();
    }
  });
});
