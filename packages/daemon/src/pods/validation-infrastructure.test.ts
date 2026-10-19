import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Pod, ValidationResult } from '@autopod/shared';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createMockContainerManager,
  createTestDb,
  insertTestProfile,
  logger,
} from '../test-utils/mock-helpers.js';
import { createEventBus } from './event-bus.js';
import { createEventRepository } from './event-repository.js';
import { createPodRepository } from './pod-repository.js';
import { validateTransition } from './state-machine.js';
import { TaskRetryBlockedError } from './task-retry-ledger.js';
import {
  createValidationInfrastructure,
  isReviewInfrastructureOnlyFailure,
  isValidationInfrastructureOnlyFailure,
  reviewInfrastructureFailureLabel,
  validationInfrastructureFailureLabel,
} from './validation-infrastructure.js';

function result(): ValidationResult {
  return {
    podId: 'worker',
    attempt: 1,
    timestamp: '2026-10-18T00:00:00.000Z',
    duration: 1,
    smoke: {
      status: 'pass',
      build: { status: 'pass', output: '', duration: 1 },
      health: { status: 'skip', url: '', responseCode: null, duration: 0 },
      pages: [],
    },
    overall: 'fail',
    taskReview: null,
    reviewSkipKind: 'review-timeout',
  };
}
function council(r: ValidationResult) {
  r.taskReview = {
    status: 'fail',
    reasoning: '',
    issues: [],
    model: 'reviewer',
    screenshots: [],
    diff: '',
    reviewBatch: {
      id: 'batch',
      diffHash: 'hash',
      reviewedHead: 'head',
      promptVersion: 'v1',
      schemaVersion: 'v1',
      model: 'reviewer',
      axes: [],
      candidates: [],
      initialFindings: [],
      accepted: [],
      rejected: [],
      merged: [],
      synthesis: 'model',
      durationMs: 1,
    },
  };
  const batch = r.taskReview.reviewBatch;
  if (!batch) throw new Error('Missing batch');
  return batch;
}
function infrastructure(r: ValidationResult, retryable = true) {
  r.infrastructureFailure = { phase: 'test', code: 'TRANSPORT', message: 'Unavailable', retryable };
}

describe('infrastructure classifiers and labels', () => {
  it.each([true, false])(
    'classifies typed infrastructure with retryable=%s, even alongside failed checks',
    (retryable) => {
      const r = result();
      infrastructure(r, retryable);
      r.smoke.build.status = 'fail';
      r.test = { status: 'fail', duration: 1 };
      expect(isValidationInfrastructureOnlyFailure(r)).toBe(true);
      expect(validationInfrastructureFailureLabel(r)).toBe(
        'Validation infrastructure failure during test',
      );
      r.overall = 'pass';
      expect(isValidationInfrastructureOnlyFailure(r)).toBe(false);
    },
  );
  it('requires typed metadata and keeps the generic fallback label', () => {
    const r = result();
    expect(isValidationInfrastructureOnlyFailure(r)).toBe(false);
    expect(validationInfrastructureFailureLabel(r)).toBe('Validation infrastructure failure');
    infrastructure(r);
    r.infrastructureFailure = undefined;
    expect(isValidationInfrastructureOnlyFailure(r)).toBe(false);
  });
  const cases: Array<{ name: string; change(r: ValidationResult): void; accepted: boolean }> = [
    {
      name: 'timeout with null review and absent optional checks',
      change: () => {},
      accepted: true,
    },
    {
      name: 'failed reviewer',
      change: (r) => {
        r.reviewSkipKind = 'review-failed';
      },
      accepted: true,
    },
    {
      name: 'missing skip kind',
      change: (r) => {
        r.reviewSkipKind = undefined;
      },
      accepted: false,
    },
    {
      name: 'profile skip',
      change: (r) => {
        r.reviewSkipKind = 'profile-skip';
      },
      accepted: false,
    },
    {
      name: 'upstream failure',
      change: (r) => {
        r.reviewSkipKind = 'upstream-failed';
      },
      accepted: false,
    },
    {
      name: 'no changes',
      change: (r) => {
        r.reviewSkipKind = 'no-changes';
      },
      accepted: false,
    },
    {
      name: 'non-null ordinary review',
      change: (r) => {
        council(r);
      },
      accepted: false,
    },
    {
      name: 'unavailable council without skip kind',
      change: (r) => {
        council(r).infrastructureUnavailable = true;
        r.reviewSkipKind = undefined;
      },
      accepted: true,
    },
    {
      name: 'false council marker',
      change: (r) => {
        council(r).infrastructureUnavailable = false;
      },
      accepted: false,
    },
    {
      name: 'unavailable closure',
      change: (r) => {
        council(r).closureVerification = { status: 'unavailable', decisions: [] };
        r.reviewSkipKind = undefined;
      },
      accepted: true,
    },
    {
      name: 'invalid closure',
      change: (r) => {
        council(r).closureVerification = { status: 'invalid', decisions: [] };
      },
      accepted: true,
    },
    {
      name: 'overall pass',
      change: (r) => {
        r.overall = 'pass';
      },
      accepted: false,
    },
    {
      name: 'failed build',
      change: (r) => {
        r.smoke.build.status = 'fail';
      },
      accepted: false,
    },
    {
      name: 'failed health',
      change: (r) => {
        r.smoke.health.status = 'fail';
      },
      accepted: false,
    },
    {
      name: 'failed page',
      change: (r) => {
        r.smoke.pages = [
          {
            path: '/',
            status: 'fail',
            screenshotPath: '',
            consoleErrors: [],
            assertions: [],
            loadTime: 1,
          },
        ];
      },
      accepted: false,
    },
    {
      name: 'passed page',
      change: (r) => {
        r.smoke.pages = [
          {
            path: '/',
            status: 'pass',
            screenshotPath: '',
            consoleErrors: [],
            assertions: [],
            loadTime: 1,
          },
        ];
      },
      accepted: true,
    },
    ...(['test', 'lint', 'sast'] as const).flatMap((phase) =>
      (['pass', 'skip', 'fail'] as const).map((status) => ({
        name: `${phase} ${status}`,
        accepted: status !== 'fail',
        change: (r: ValidationResult) => {
          if (phase === 'test') r.test = { status, duration: 1 };
          else r[phase] = { status, duration: 1, output: '' };
        },
      })),
    ),
    ...(['pass', 'skip', 'fail', 'pending_human'] as const).map((status) => ({
      name: `facts ${status}`,
      accepted: status === 'pass' || status === 'skip',
      change: (r: ValidationResult) => {
        r.factValidation = { status, results: [] };
      },
    })),
    {
      name: 'null facts',
      change: (r) => {
        r.factValidation = null;
      },
      accepted: true,
    },
    {
      name: 'setup failure is not an added predicate',
      change: (r) => {
        r.setup = { status: 'fail', output: '', duration: 1 };
      },
      accepted: true,
    },
  ];
  it.each(cases)('$name → $accepted', ({ change, accepted }) => {
    const r = result();
    change(r);
    expect(isReviewInfrastructureOnlyFailure(r)).toBe(accepted);
  });
  it('keeps council then closure then timeout then generic label precedence', () => {
    const r = result();
    expect(reviewInfrastructureFailureLabel(r)).toBe('Review infrastructure timeout');
    r.reviewSkipKind = 'review-failed';
    expect(reviewInfrastructureFailureLabel(r)).toBe('Review infrastructure failure');
    const batch = council(r);
    for (const status of ['unavailable', 'invalid'] as const) {
      batch.closureVerification = { status, decisions: [] };
      expect(reviewInfrastructureFailureLabel(r)).toBe(
        'Review finding closure infrastructure failure',
      );
    }
    batch.infrastructureUnavailable = true;
    expect(reviewInfrastructureFailureLabel(r)).toBe(
      'Frozen review council infrastructure failure',
    );
  });
  it('retains strict true classification versus truthy council label for malformed runtime data', () => {
    const r = result();
    const batch = council(r);
    Object.assign(batch, { infrastructureUnavailable: 'unavailable' });
    expect(isReviewInfrastructureOnlyFailure(r)).toBe(false);
    expect(reviewInfrastructureFailureLabel(r)).toBe(
      'Frozen review council infrastructure failure',
    );
  });
});

type Parking = 'admission' | 'validation' | 'review';
const paths: Parking[] = ['admission', 'validation', 'review'];
const cleanup: Array<() => void> = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const close of cleanup.splice(0).reverse()) close();
});

// This transition fixture proves the injected callback contract with real state validation,
// repositories and events. Actual manager readiness/transition integration is covered publicly.
function fixture(container = true, target: Pod['executionTarget'] = 'local') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'validation-infrastructure-'));
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
    task: 'Parking contract',
    status: 'validating',
    model: 'model',
    runtime: 'claude',
    executionTarget: target,
    branch: 'feature/infrastructure',
    userId: 'operator',
    maxValidationAttempts: 5,
    skipValidation: false,
    outputMode: 'pr',
  });
  repo.update('worker', {
    containerId: container ? 'container' : null,
    validationAttempts: 3,
    lastCorrectionMessage: 'Retained correction',
    failureReason: 'Retained reason',
  });
  const pod = repo.getOrThrow('worker');
  const events = createEventRepository(db);
  const bus = createEventBus(events, logger);
  const order: string[] = [];
  const update = repo.update.bind(repo);
  const writes = vi.spyOn(repo, 'update').mockImplementation((id, changes) => {
    order.push(changes.status ? 'status-write' : 'refund-write');
    update(id, changes);
  });
  const cm = createMockContainerManager();
  const stop = vi.mocked(cm.stop).mockImplementation(async () => {
    order.push('stop');
  });
  const log = {
    info: vi.fn(() => {
      order.push('info');
    }),
    warn: vi.fn(() => {
      order.push('warn');
    }),
  };
  const transition = vi.fn<Parameters<typeof createValidationInfrastructure>[0]['transition']>(
    (snapshot, to, extra) => {
      order.push('transition');
      validateTransition(snapshot.id, snapshot.status, to);
      repo.update(snapshot.id, { status: to, ...extra });
      bus.emit({
        type: 'pod.status_changed',
        podId: snapshot.id,
        timestamp: '2026-10-18T00:00:00.000Z',
        previousStatus: snapshot.status,
        newStatus: to,
      });
      return repo.getOrThrow(snapshot.id);
    },
  );
  const preview = vi.fn(async (_id: string) => {
    order.push('preview');
  });
  const get = vi.fn((_target: Pod['executionTarget']) => {
    order.push('get');
    return cm;
  });
  const activity = vi.fn((_id: string, message: string) => {
    order.push(
      message === 'Stopping post-validation container…' ? 'stopping-activity' : 'initial-activity',
    );
  });
  const deps: Parameters<typeof createValidationInfrastructure>[0] = {
    logger: log,
    podRepo: repo,
    containerManagerFactory: { get },
    transition,
    stopSandboxPreviewProxy: preview,
    emitActivityStatus: activity,
  };
  const r = result();
  infrastructure(r);
  const blocked = new TaskRetryBlockedError('Task retry budget exhausted');
  const make = () => createValidationInfrastructure(deps);
  const run = (kind: Parking, snapshot = pod, op = make()) =>
    kind === 'admission'
      ? op.parkOnRetryAdmission(snapshot, blocked)
      : kind === 'validation'
        ? op.parkOnValidationInfrastructureFailure(snapshot, r)
        : op.parkOnReviewInfrastructureFailure(snapshot);
  return {
    pod,
    repo,
    writes,
    db: () => db,
    bus,
    events,
    order,
    cm,
    stop,
    log,
    transition,
    preview,
    get,
    activity,
    deps,
    r,
    blocked,
    make,
    run,
    reopen: () => {
      db.close();
      db = new Database(file);
      db.pragma('foreign_keys = ON');
      expect(db.pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }]);
      expect(db.pragma('foreign_key_check')).toEqual([]);
      return {
        pod: createPodRepository(db).getOrThrow('worker'),
        events: createEventRepository(db).getForSession('worker', { type: 'pod.status_changed' }),
      };
    },
  };
}
function expectedPrefix(kind: Parking) {
  return kind === 'admission'
    ? ['initial-activity', 'transition', 'status-write', 'refund-write']
    : kind === 'validation'
      ? ['initial-activity', 'transition', 'status-write', 'refund-write', 'stopping-activity']
      : ['transition', 'status-write', 'stopping-activity'];
}

describe('createValidationInfrastructure parking contracts', () => {
  it('constructs without collaborator calls or writes', () => {
    const f = fixture();
    f.make();
    expect(f.order).toEqual([]);
    expect(f.writes).not.toHaveBeenCalled();
    expect(f.activity).not.toHaveBeenCalled();
    expect(f.transition).not.toHaveBeenCalled();
    expect(f.preview).not.toHaveBeenCalled();
    expect(f.get).not.toHaveBeenCalled();
    expect(f.stop).not.toHaveBeenCalled();
  });
  it.each(
    paths.flatMap((kind) => (['local', 'sandbox'] as const).map((target) => ({ kind, target }))),
  )(
    '$kind uses snapshot arguments and ordered $target shutdown with durable results',
    async ({ kind, target }) => {
      const f = fixture(true, target);
      await f.run(kind);
      expect(f.order).toEqual([
        ...expectedPrefix(kind),
        'preview',
        'get',
        'stop',
        ...(kind === 'admission' ? [] : ['info']),
      ]);
      expect(f.transition.mock.calls[0]?.[0]).toBe(f.pod);
      expect(f.transition.mock.calls[0]?.slice(1)).toEqual(
        kind === 'admission'
          ? ['review_required', { failureReason: f.blocked.message }]
          : ['review_required'],
      );
      expect(f.preview).toHaveBeenCalledExactlyOnceWith('worker');
      expect(f.get).toHaveBeenCalledExactlyOnceWith(target);
      expect(f.stop).toHaveBeenCalledExactlyOnceWith('container');
      if (kind === 'admission')
        expect(f.activity).toHaveBeenCalledExactlyOnceWith('worker', f.blocked.message);
      if (kind === 'validation')
        expect(f.activity.mock.calls).toEqual([
          ['worker', 'Validation infrastructure failure during test — parked for explicit Resume'],
          ['worker', 'Stopping post-validation container…'],
        ]);
      if (kind === 'review')
        expect(f.activity).toHaveBeenCalledExactlyOnceWith(
          'worker',
          'Stopping post-validation container…',
        );
      if (kind === 'admission') expect(f.log.info).not.toHaveBeenCalled();
      else
        expect(f.log.info).toHaveBeenCalledExactlyOnceWith(
          kind === 'validation'
            ? { podId: 'worker', infrastructureFailure: f.r.infrastructureFailure }
            : { podId: 'worker' },
          `Container stopped after ${kind} infrastructure failure`,
        );
      const saved = f.reopen();
      expect(saved.pod).toMatchObject({
        status: 'review_required',
        validationAttempts: kind === 'review' ? 3 : 2,
        lastCorrectionMessage: kind === 'validation' ? null : 'Retained correction',
        failureReason: kind === 'admission' ? f.blocked.message : 'Retained reason',
      });
      expect(saved.events).toHaveLength(1);
    },
  );
  it.each(paths)('%s has no teardown/activity/logging when container is absent', async (kind) => {
    const f = fixture(false);
    await f.run(kind);
    expect(f.order).toEqual(expectedPrefix(kind).filter((x) => x !== 'stopping-activity'));
    expect(f.preview).not.toHaveBeenCalled();
    expect(f.get).not.toHaveBeenCalled();
    expect(f.log.info).not.toHaveBeenCalled();
    expect(f.reopen().pod.status).toBe('review_required');
  });
  it.each(['running', 'review_required', 'killed'] as const)(
    'denied admission is a snapshot no-op in %s',
    async (status) => {
      const f = fixture();
      await f.run('admission', { ...f.pod, status });
      expect(f.order).toEqual([]);
      expect(f.reopen().pod).toMatchObject({ status: 'validating', validationAttempts: 3 });
    },
  );
  it.each(
    (['admission', 'validation'] as const).flatMap((kind) =>
      [0, -2, 1, 7].map((count) => ({ kind, count })),
    ),
  )(
    '$kind clamps a passed count of $count independently of current storage',
    async ({ kind, count }) => {
      const f = fixture(false);
      await f.run(kind, { ...f.pod, validationAttempts: count });
      expect(f.reopen().pod.validationAttempts).toBe(Math.max(0, count - 1));
    },
  );
  it.each(paths)(
    '%s keeps the passed snapshot despite synchronous subscriber and transition return changes',
    async (kind) => {
      const f = fixture();
      const transition = f.transition.getMockImplementation();
      if (!transition) throw new Error('Missing transition fixture');
      const unsubscribe = f.bus.subscribe(() =>
        f.repo.update('worker', {
          validationAttempts: 80,
          lastCorrectionMessage: 'Subscriber correction',
        }),
      );
      f.transition.mockImplementation((...args) => ({
        ...transition(...args),
        validationAttempts: 99,
        containerId: 'different',
        executionTarget: 'sandbox',
      }));
      try {
        await f.run(kind);
        expect(f.stop).toHaveBeenCalledExactlyOnceWith('container');
        expect(f.get).toHaveBeenCalledExactlyOnceWith('local');
        expect(f.reopen().pod).toMatchObject({
          validationAttempts: kind === 'review' ? 80 : 2,
          lastCorrectionMessage: kind === 'validation' ? null : 'Subscriber correction',
        });
      } finally {
        unsubscribe();
      }
    },
  );
  it('captures dependency objects/functions while retaining late method lookup', async () => {
    const f = fixture();
    const op = f.make();
    const capturedLog = f.deps.logger;
    const capturedFactory = f.deps.containerManagerFactory;
    f.deps.logger = { info: vi.fn(), warn: vi.fn() };
    f.deps.containerManagerFactory = {
      get: vi.fn(() => {
        throw new Error('replacement');
      }),
    };
    f.deps.podRepo = {
      update: vi.fn(() => {
        throw new Error('replacement');
      }),
    };
    f.deps.transition = vi.fn(() => {
      throw new Error('replacement');
    });
    f.deps.stopSandboxPreviewProxy = vi.fn(() => {
      throw new Error('replacement');
    });
    f.deps.emitActivityStatus = vi.fn(() => {
      throw new Error('replacement');
    });
    const info = vi.fn();
    capturedLog.info = info;
    const get = vi.fn(() => f.cm);
    capturedFactory.get = get;
    const stop = vi.fn(async () => {});
    f.cm.stop = stop;
    await f.run('validation', f.pod, op);
    expect(f.transition).toHaveBeenCalled();
    expect(f.preview).toHaveBeenCalled();
    expect(f.activity).toHaveBeenCalledTimes(2);
    expect(f.writes).toHaveBeenCalledTimes(2);
    expect(get).toHaveBeenCalledExactlyOnceWith('local');
    expect(stop).toHaveBeenCalledExactlyOnceWith('container');
    expect(info).toHaveBeenCalledOnce();
    expect(f.deps.transition).not.toHaveBeenCalled();
    expect(f.deps.logger.info).not.toHaveBeenCalled();
    expect(f.reopen().pod.status).toBe('review_required');
  });
  it.each(paths)(
    '%s awaits preview completion before looking up and stopping the container',
    async (kind) => {
      const f = fixture();
      let release = () => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      f.preview.mockImplementation(async () => {
        f.order.push('preview-held');
        await gate;
        f.order.push('preview-done');
      });
      const running = f.run(kind);
      try {
        expect(f.get).not.toHaveBeenCalled();
        expect(f.stop).not.toHaveBeenCalled();
        expect(f.repo.getOrThrow('worker').status).toBe('review_required');
      } finally {
        release();
        await running;
      }
      expect(f.order.slice(-4)).toEqual(
        kind === 'admission'
          ? ['preview-held', 'preview-done', 'get', 'stop']
          : ['preview-done', 'get', 'stop', 'info'],
      );
      expect(f.reopen().pod.status).toBe('review_required');
    },
  );
  it.each(
    paths.flatMap((kind) =>
      [
        'preview',
        'get',
        'stop',
        ...(kind === 'admission' ? [] : ['info', 'stopping-activity']),
      ].map((stage) => ({ kind, stage })),
    ),
  )('$kind catches $stage failure at the original stop boundary', async ({ kind, stage }) => {
    const f = fixture();
    const error = new Error(`${stage} failed`);
    if (stage === 'preview') f.preview.mockRejectedValue(error);
    if (stage === 'get')
      f.get.mockImplementation(() => {
        throw error;
      });
    if (stage === 'stop') f.stop.mockRejectedValue(error);
    if (stage === 'info')
      f.log.info.mockImplementation(() => {
        throw error;
      });
    if (stage === 'stopping-activity')
      f.activity.mockImplementation((_id, message) => {
        if (message === 'Stopping post-validation container…') throw error;
      });
    await expect(f.run(kind)).resolves.toBeUndefined();
    expect(f.log.warn).toHaveBeenCalledExactlyOnceWith(
      { err: error, podId: 'worker' },
      kind === 'admission'
        ? 'Failed to stop container after retry admission was denied'
        : `Failed to stop container after ${kind} infrastructure failure`,
    );
    expect(f.stop).toHaveBeenCalledTimes(['stop', 'info'].includes(stage) ? 1 : 0);
    expect(f.reopen().pod.status).toBe('review_required');
  });
  it.each(paths)('%s propagates the warning error after preview rejection', async (kind) => {
    const f = fixture();
    const original = new Error('Preview failed');
    const warning = new Error('Warning failed');
    f.preview.mockRejectedValue(original);
    f.log.warn.mockImplementation(() => {
      throw warning;
    });
    await expect(f.run(kind)).rejects.toBe(warning);
    expect(f.stop).not.toHaveBeenCalled();
    expect(f.reopen().pod.status).toBe('review_required');
  });
  it.each(paths)(
    '%s propagates injected transition failure by identity before any writes/stop',
    async (kind) => {
      const f = fixture();
      const error = new Error('Transition failed');
      f.transition.mockImplementation(() => {
        throw error;
      });
      await expect(f.run(kind)).rejects.toBe(error);
      expect(f.writes).not.toHaveBeenCalled();
      expect(f.preview).not.toHaveBeenCalled();
      expect(f.stop).not.toHaveBeenCalled();
      expect(f.reopen().pod).toMatchObject({ status: 'validating', validationAttempts: 3 });
    },
  );
  it.each(['admission', 'validation'] as const)(
    '%s propagates initial activity failure without entering transition',
    async (kind) => {
      const f = fixture();
      const error = new Error('Activity failed');
      f.activity.mockImplementation(() => {
        throw error;
      });
      await expect(f.run(kind)).rejects.toBe(error);
      expect(f.transition).not.toHaveBeenCalled();
      expect(f.preview).not.toHaveBeenCalled();
      expect(f.reopen().pod.status).toBe('validating');
    },
  );
  it.each(['validation', 'review'] as const)(
    '%s retains real state-machine rejection for an invalid snapshot',
    async (kind) => {
      const f = fixture();
      await expect(f.run(kind, { ...f.pod, status: 'killed' })).rejects.toThrow(
        'from killed to review_required',
      );
      expect(f.writes).not.toHaveBeenCalled();
      expect(f.stop).not.toHaveBeenCalled();
      expect(f.reopen().pod.status).toBe('validating');
    },
  );
  it.each(paths)(
    '%s preserves SQLite transition failure with no later effects after reopen',
    async (kind) => {
      const f = fixture();
      f.db().exec(
        "CREATE TRIGGER reject_parking BEFORE UPDATE OF status ON pods WHEN NEW.status = 'review_required' BEGIN SELECT RAISE(ABORT, 'transition rejected'); END",
      );
      await expect(f.run(kind)).rejects.toThrow('transition rejected');
      expect(f.preview).not.toHaveBeenCalled();
      expect(f.stop).not.toHaveBeenCalled();
      const saved = f.reopen();
      expect(saved.pod).toMatchObject({
        status: 'validating',
        validationAttempts: 3,
        lastCorrectionMessage: 'Retained correction',
        failureReason: 'Retained reason',
      });
      expect(saved.events).toHaveLength(0);
    },
  );
  it.each(['admission', 'validation'] as const)(
    '%s leaves the real parked prefix durable when the refund SQL aborts',
    async (kind) => {
      const f = fixture();
      f.db().exec(
        "CREATE TRIGGER reject_refund BEFORE UPDATE OF validation_attempts ON pods WHEN NEW.validation_attempts = 2 BEGIN SELECT RAISE(ABORT, 'refund rejected'); END",
      );
      await expect(f.run(kind)).rejects.toThrow('refund rejected');
      expect(f.preview).not.toHaveBeenCalled();
      expect(f.stop).not.toHaveBeenCalled();
      const saved = f.reopen();
      expect(saved.pod).toMatchObject({
        status: 'review_required',
        validationAttempts: 3,
        lastCorrectionMessage: 'Retained correction',
        failureReason: kind === 'admission' ? f.blocked.message : 'Retained reason',
      });
      expect(saved.events).toHaveLength(1);
    },
  );
  it.each(['admission', 'validation'] as const)(
    '%s propagates injected refund failure by identity after durable transition',
    async (kind) => {
      const f = fixture();
      const error = new Error('Refund failed');
      const update = f.writes.getMockImplementation();
      if (!update) throw new Error('Missing update fixture');
      f.writes.mockImplementation((id, changes) => {
        if (changes.validationAttempts === 2) throw error;
        update(id, changes);
      });
      await expect(f.run(kind)).rejects.toBe(error);
      expect(f.preview).not.toHaveBeenCalled();
      expect(f.reopen().pod).toMatchObject({ status: 'review_required', validationAttempts: 3 });
    },
  );
});
