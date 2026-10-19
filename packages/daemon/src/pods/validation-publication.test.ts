import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Pod, ValidationResult } from '@autopod/shared';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTestDb, insertTestProfile, logger } from '../test-utils/mock-helpers.js';
import { createEventBus } from './event-bus.js';
import { createEventRepository } from './event-repository.js';
import { createPodRepository } from './pod-repository.js';
import { createValidationPublication } from './validation-publication.js';
import { createValidationRepository } from './validation-repository.js';

type Usage = NonNullable<ValidationResult['reviewTokenUsage']>;
const cleanup: Array<() => void> = [];
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  for (const close of cleanup.splice(0).reverse()) close();
});
function required<T>(value: T | null | undefined): T {
  if (value == null) throw new Error('Expected publication fixture value');
  return value;
}
function fixture(
  prior: Pod['phaseTokenUsage'] = {
    agent_initial: { inputTokens: 100, outputTokens: 50 },
    review: { inputTokens: 5, outputTokens: 7, cachedInputTokens: 2, costUsd: 0.25 },
  },
) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'validation-publication-'));
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
  const podRepo = createPodRepository(db);
  podRepo.insert({
    id: 'worker',
    profileName: 'test-profile',
    task: 'Publish result',
    status: 'validating',
    model: 'model',
    runtime: 'claude',
    executionTarget: 'local',
    branch: 'feature/publication',
    userId: 'operator',
    maxValidationAttempts: 3,
    skipValidation: false,
    outputMode: 'pr',
  });
  podRepo.update('worker', { phaseTokenUsage: prior });
  const history = createValidationRepository(db);
  const events = createEventRepository(db);
  const bus = createEventBus(events, logger);
  const result: ValidationResult = {
    podId: 'engine-id',
    attempt: 9,
    timestamp: '2026-10-18T00:00:00.000Z',
    smoke: {
      status: 'pass',
      build: { status: 'pass', output: '', duration: 1 },
      health: { status: 'pass', url: '', responseCode: 200, duration: 1 },
      pages: [],
    },
    taskReview: null,
    overall: 'pass',
    duration: 1,
  };
  const deps: Parameters<typeof createValidationPublication>[0] = {
    podRepo,
    validationRepo: history,
    eventBus: bus,
  };
  return {
    root,
    file,
    db: () => db,
    podRepo,
    history,
    events,
    bus,
    result,
    deps,
    prior,
    make: () => createValidationPublication(deps),
    run: (attempt = 1) =>
      createValidationPublication(deps).publishValidationResult('worker', attempt, result),
    review: (tokenUsage?: Usage) => {
      result.taskReview = {
        status: 'pass',
        reasoning: 'Synthetic review',
        issues: [],
        model: 'reviewer',
        screenshots: [],
        diff: '',
        tokenUsage,
      };
    },
    reopen: () => {
      db.close();
      db = new Database(file);
      db.pragma('foreign_keys = ON');
      expect(db.pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }]);
      expect(db.pragma('foreign_key_check')).toEqual([]);
      return {
        pod: createPodRepository(db).getOrThrow('worker'),
        history: createValidationRepository(db).getForSession('worker'),
        events: createEventRepository(db).getForSession('worker', {
          type: 'pod.validation_completed',
        }),
      };
    },
  };
}
const metered: Usage = { inputTokens: 10, outputTokens: 20, cachedInputTokens: 3, costUsd: 0.5 };

describe('createValidationPublication', () => {
  it('constructs without effects, returns the actual history record synchronously and keeps forwarding/order', async () => {
    const f = fixture();
    f.result.reviewTokenUsage = metered;
    const order: string[] = [];
    const update = f.podRepo.update.bind(f.podRepo);
    const get = f.podRepo.getOrThrow.bind(f.podRepo);
    const insert = f.history.insert.bind(f.history);
    const emit = f.bus.emit.bind(f.bus);
    const updates = vi.spyOn(f.podRepo, 'update').mockImplementation((id, changes) => {
      order.push(changes.lastValidationResult ? 'result' : 'usage');
      update(id, changes);
    });
    const reads = vi.spyOn(f.podRepo, 'getOrThrow').mockImplementation((id) => {
      order.push('read');
      return get(id);
    });
    const inserts = vi.spyOn(f.history, 'insert').mockImplementation((...args) => {
      order.push('history');
      return insert(...args);
    });
    const emits = vi.spyOn(f.bus, 'emit').mockImplementation((event) => {
      order.push('event');
      return emit(event);
    });
    const op = f.make();
    expect(order).toEqual([]);
    let microtaskRan = false;
    const pending = Promise.resolve().then(() => {
      microtaskRan = true;
    });
    const record = op.publishValidationResult('worker', 4, f.result);
    expect(record).not.toBeInstanceOf(Promise);
    expect(microtaskRan).toBe(false);
    expect(record).toBe(inserts.mock.results[0]?.value);
    expect(order).toEqual(['result', 'read', 'usage', 'history', 'event']);
    expect(updates.mock.calls[0]).toEqual(['worker', { lastValidationResult: f.result }]);
    expect(updates.mock.calls[0]?.[1].lastValidationResult).toBe(f.result);
    expect(reads).toHaveBeenCalledExactlyOnceWith('worker');
    expect(inserts).toHaveBeenCalledExactlyOnceWith('worker', 4, f.result);
    expect(emits.mock.calls[0]?.[0]).toMatchObject({
      type: 'pod.validation_completed',
      podId: 'worker',
      result: f.result,
    });
    expect(
      emits.mock.calls[0]?.[0].type === 'pod.validation_completed' &&
        emits.mock.calls[0]?.[0].result,
    ).toBe(f.result);
    await pending;
    expect(microtaskRan).toBe(true);
    const saved = f.reopen();
    expect(saved.pod.lastValidationResult).toEqual(f.result);
    expect(saved.history[0]).toEqual(record);
    expect(saved.events).toHaveLength(1);
  });

  it.each([
    {
      name: 'no usage',
      task: undefined,
      fallback: undefined,
      expected: { inputTokens: 5, outputTokens: 7, cachedInputTokens: 2, costUsd: 0.25 },
    },
    {
      name: 'task usage',
      task: metered,
      fallback: undefined,
      expected: { inputTokens: 15, outputTokens: 27, cachedInputTokens: 5, costUsd: 0.75 },
    },
    {
      name: 'fallback without task usage',
      task: undefined,
      fallback: metered,
      expected: { inputTokens: 15, outputTokens: 27, cachedInputTokens: 5, costUsd: 0.75 },
    },
    {
      name: 'task priority',
      task: metered,
      fallback: { inputTokens: 900, outputTokens: 800, costUsd: 90 },
      expected: { inputTokens: 15, outputTokens: 27, cachedInputTokens: 5, costUsd: 0.75 },
    },
    {
      name: 'selected zero object',
      task: { inputTokens: 0, outputTokens: 0 },
      fallback: metered,
      expected: { inputTokens: 5, outputTokens: 7, cachedInputTokens: 2, costUsd: 0.25 },
    },
  ])('persists $name exactly after reopen', ({ task, fallback, expected }) => {
    const f = fixture();
    f.review(task);
    f.result.reviewTokenUsage = fallback;
    f.run();
    const saved = f.reopen();
    expect(saved.pod.phaseTokenUsage).toEqual({
      agent_initial: { inputTokens: 100, outputTokens: 50 },
      review: expected,
    });
    const serializedResult = JSON.parse(JSON.stringify(f.result));
    expect(saved.pod.lastValidationResult).toStrictEqual(serializedResult);
    expect(saved.history[0]?.result).toStrictEqual(serializedResult);
    const payload = saved.events[0]?.payload;
    if (payload?.type !== 'pod.validation_completed') throw new Error('Missing completion event');
    expect(payload.result).toStrictEqual(serializedResult);
  });

  it.each([
    null,
    { agent_initial: { inputTokens: 100, outputTokens: 50 } },
    { review: { inputTokens: 0, outputTokens: 0 } },
  ])('starts from absent or minimal usage map %#', (prior) => {
    const f = fixture(prior);
    f.result.reviewTokenUsage = { inputTokens: 10, outputTokens: 20 };
    f.run();
    expect(f.reopen().pod.phaseTokenUsage).toEqual({
      ...prior,
      review: { inputTokens: 10, outputTokens: 20 },
    });
  });

  it('does not read or rewrite usage when both sources are absent', () => {
    const f = fixture(null);
    const get = vi.spyOn(f.podRepo, 'getOrThrow');
    const update = vi.spyOn(f.podRepo, 'update');
    f.run();
    expect(get).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledOnce();
    expect(f.reopen().pod.phaseTokenUsage).toBeNull();
  });

  it('writes selected zero usage rather than selecting a metered fallback or skipping accounting', () => {
    const f = fixture(null);
    f.review({ inputTokens: 0, outputTokens: 0 });
    f.result.reviewTokenUsage = metered;
    const update = vi.spyOn(f.podRepo, 'update');
    const get = vi.spyOn(f.podRepo, 'getOrThrow');
    f.run();
    expect(update).toHaveBeenCalledTimes(2);
    expect(get).toHaveBeenCalledExactlyOnceWith('worker');
    expect(f.reopen().pod.phaseTokenUsage).toEqual({ review: { inputTokens: 0, outputTokens: 0 } });
  });

  it('selects metered fallback with no task-review verdict', () => {
    const f = fixture(null);
    f.result.reviewTokenUsage = metered;
    f.result.reviewSkipKind = 'review-failed';
    f.run();
    expect(f.reopen().pod.phaseTokenUsage?.review).toEqual(metered);
  });

  it.each([
    { name: 'zero totals', cachedInputTokens: -2, costUsd: -0.25, expected: {} },
    { name: 'negative totals', cachedInputTokens: -3, costUsd: -0.5, expected: {} },
    {
      name: 'missing values',
      cachedInputTokens: undefined,
      costUsd: undefined,
      expected: { cachedInputTokens: 2, costUsd: 0.25 },
    },
    {
      name: 'positive totals',
      cachedInputTokens: 1,
      costUsd: 0.25,
      expected: { cachedInputTokens: 3, costUsd: 0.5 },
    },
  ])(
    'preserves strict positive optional-field inclusion for $name',
    ({ cachedInputTokens, costUsd, expected }) => {
      const f = fixture();
      f.result.reviewTokenUsage = { inputTokens: 1, outputTokens: 2, cachedInputTokens, costUsd };
      f.run();
      expect(f.reopen().pod.phaseTokenUsage?.review).toEqual({
        inputTokens: 6,
        outputTokens: 9,
        ...expected,
      });
    },
  );

  it('keeps raw input/output sums and rebuilds rather than spreads the review bucket', () => {
    const f = fixture();
    f.db()
      .prepare('UPDATE pods SET phase_token_usage=? WHERE id=?')
      .run(
        JSON.stringify({
          agent_initial: { inputTokens: 100, outputTokens: 50 },
          review: { inputTokens: 5, outputTokens: 7, extra: 'drop-existing-unknown-key' },
        }),
        'worker',
      );
    f.result.reviewTokenUsage = { inputTokens: -6, outputTokens: -8 };
    f.run();
    expect(f.reopen().pod.phaseTokenUsage).toEqual({
      agent_initial: { inputTokens: 100, outputTokens: 50 },
      review: { inputTokens: -1, outputTokens: -1 },
    });
  });

  it('reads current usage after the first result write rather than using a prior snapshot', () => {
    const f = fixture();
    f.result.reviewTokenUsage = metered;
    const update = f.podRepo.update.bind(f.podRepo);
    vi.spyOn(f.podRepo, 'update').mockImplementation((id, changes) => {
      update(id, changes);
      if (changes.lastValidationResult)
        f.db()
          .prepare('UPDATE pods SET phase_token_usage=? WHERE id=?')
          .run(JSON.stringify({ review: { inputTokens: 1000, outputTokens: 2000 } }), id);
    });
    f.run();
    expect(f.reopen().pod.phaseTokenUsage?.review).toEqual({
      ...metered,
      inputTokens: 1010,
      outputTokens: 2020,
    });
  });

  it('skips only history when it is absent and returns undefined synchronously', () => {
    const f = fixture();
    f.deps.validationRepo = undefined;
    f.result.reviewTokenUsage = metered;
    expect(f.run()).toBeUndefined();
    const saved = f.reopen();
    expect(saved.history).toEqual([]);
    expect(saved.events).toHaveLength(1);
    expect(saved.pod.lastValidationResult).toEqual(f.result);
    expect(saved.pod.phaseTokenUsage?.review?.inputTokens).toBe(15);
  });

  it('captures the same three objects while looking up current methods when invoked', () => {
    const f = fixture();
    f.result.reviewTokenUsage = metered;
    const op = f.make();
    const replacementUpdate = vi.fn();
    const replacementGet = vi.fn(() => {
      throw new Error('replacement repo');
    });
    const replacementInsert = vi.fn(() => {
      throw new Error('replacement history');
    });
    const replacementEmit = vi.fn(() => 0);
    f.deps.podRepo = { update: replacementUpdate, getOrThrow: replacementGet };
    f.deps.validationRepo = { insert: replacementInsert };
    f.deps.eventBus = { emit: replacementEmit };
    const update = vi.spyOn(f.podRepo, 'update');
    const insert = vi.spyOn(f.history, 'insert');
    const emit = vi.spyOn(f.bus, 'emit');
    op.publishValidationResult('worker', 1, f.result);
    expect(update).toHaveBeenCalledTimes(2);
    expect(insert).toHaveBeenCalledOnce();
    expect(emit).toHaveBeenCalledOnce();
    expect(replacementUpdate).not.toHaveBeenCalled();
    expect(replacementGet).not.toHaveBeenCalled();
    expect(replacementInsert).not.toHaveBeenCalled();
    expect(replacementEmit).not.toHaveBeenCalled();
    expect(f.reopen().history).toHaveLength(1);
  });

  it('retains absent history after a later dependency property assignment', () => {
    const f = fixture();
    f.deps.validationRepo = undefined;
    const op = f.make();
    f.deps.validationRepo = f.history;
    expect(op.publishValidationResult('worker', 1, f.result)).toBeUndefined();
    expect(f.reopen().history).toEqual([]);
  });

  it('keeps unique history identities and cumulative usage across repeated and reset attempts', () => {
    const f = fixture(null);
    f.result.reviewTokenUsage = { inputTokens: 10, outputTokens: 20 };
    const records = [
      required(f.run(1)),
      required(f.run(2)),
      required(f.run(1)),
      required(f.run(1)),
    ];
    expect(new Set(records.map((r) => r.id)).size).toBe(4);
    expect(records.map((r) => [r.attempt, r.sequence, r.cycle])).toEqual([
      [1, 1, 0],
      [2, 2, 0],
      [1, 3, 1],
      [1, 4, 2],
    ]);
    const saved = f.reopen();
    expect(saved.history).toEqual(records);
    expect(saved.events).toHaveLength(4);
    expect(saved.pod.phaseTokenUsage?.review).toEqual({ inputTokens: 40, outputTokens: 80 });
  });

  it('creates event timestamp after history insertion using the existing Date clock', () => {
    const f = fixture();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-18T01:00:00Z'));
    const insert = f.history.insert.bind(f.history);
    vi.spyOn(f.history, 'insert').mockImplementation((...args) => {
      const record = insert(...args);
      vi.setSystemTime(new Date('2026-10-18T02:00:00Z'));
      return record;
    });
    f.run();
    expect(f.reopen().events[0]?.payload.timestamp).toBe('2026-10-18T02:00:00.000Z');
  });

  it('lets synchronous listeners observe persisted state and mutate current status before return', () => {
    const f = fixture();
    f.result.reviewTokenUsage = metered;
    const observed: Array<{
      history: number;
      event: number;
      usage: number | undefined;
      result: ValidationResult | null;
    }> = [];
    f.bus.subscribe((event) => {
      if (event.type !== 'pod.validation_completed') return;
      const pod = f.podRepo.getOrThrow('worker');
      observed.push({
        history: f.history.getForSession('worker').length,
        event: f.events.countForSession('worker', event.type),
        usage: pod.phaseTokenUsage?.review?.inputTokens,
        result: pod.lastValidationResult,
      });
      f.podRepo.update('worker', { status: 'killed' });
    });
    f.run();
    expect(observed).toEqual([{ history: 1, event: 1, usage: 15, result: f.result }]);
    expect(f.reopen().pod.status).toBe('killed');
  });

  it('passes original result to listeners without rewriting pre-event JSON snapshots after mutation', () => {
    const f = fixture();
    let original: ValidationResult | undefined;
    f.bus.subscribe((event) => {
      if (event.type === 'pod.validation_completed') {
        original = event.result;
        event.result.reviewSkipReason = 'listener mutation';
      }
    });
    const record = f.run();
    expect(original).toBe(f.result);
    expect(f.result.reviewSkipReason).toBe('listener mutation');
    expect(record?.result.reviewSkipReason).toBeUndefined();
    const saved = f.reopen();
    expect(saved.pod.lastValidationResult?.reviewSkipReason).toBeUndefined();
    expect(saved.history[0]?.result.reviewSkipReason).toBeUndefined();
    const payload = saved.events[0]?.payload;
    expect(
      payload?.type === 'pod.validation_completed' && payload.result.reviewSkipReason,
    ).toBeUndefined();
  });

  it('retains real event-bus isolation when a subscriber throws', () => {
    const f = fixture();
    const received: ValidationResult[] = [];
    f.bus.subscribe(() => {
      throw new Error('subscriber failure');
    });
    f.bus.subscribe((event) => {
      if (event.type === 'pod.validation_completed') received.push(event.result);
    });
    expect(f.run()).toBeDefined();
    expect(received).toEqual([f.result]);
    expect(f.reopen().events).toHaveLength(1);
  });

  it.each(['result', 'usage', 'history', 'event'] as const)(
    'proves earlier durable effects after real SQL %s failure',
    (stage) => {
      const f = fixture();
      f.result.reviewTokenUsage = metered;
      const clauses = {
        result: "BEFORE UPDATE OF last_validation_result ON pods WHEN NEW.id='worker'",
        usage: "AFTER UPDATE OF phase_token_usage ON pods WHEN NEW.id='worker'",
        history: "AFTER INSERT ON validations WHEN NEW.pod_id='worker'",
        event: "BEFORE INSERT ON events WHEN NEW.type='pod.validation_completed'",
      };
      f.db().exec(
        `CREATE TRIGGER fail_publication ${clauses[stage]} BEGIN SELECT RAISE(ABORT, 'publication-${stage}-failed'); END`,
      );
      let received = 0;
      f.bus.subscribe(() => {
        received++;
      });
      try {
        expect(() => f.run()).toThrow(`publication-${stage}-failed`);
      } finally {
        f.db().exec('DROP TRIGGER fail_publication');
      }
      const saved = f.reopen();
      expect(received).toBe(0);
      expect(saved.pod.lastValidationResult).toEqual(stage === 'result' ? null : f.result);
      expect(saved.pod.phaseTokenUsage).toEqual(
        stage === 'result' || stage === 'usage'
          ? f.prior
          : {
              ...f.prior,
              review: { inputTokens: 15, outputTokens: 27, cachedInputTokens: 5, costUsd: 0.75 },
            },
      );
      expect(saved.history).toHaveLength(stage === 'event' ? 1 : 0);
      expect(saved.events).toEqual([]);
    },
  );

  it.each(['read', 'insert', 'emit'] as const)(
    'retains original controlled %s error and partial effects',
    (stage) => {
      const f = fixture();
      f.result.reviewTokenUsage = metered;
      const error = new Error(`contract-${stage}`);
      if (stage === 'read')
        vi.spyOn(f.podRepo, 'getOrThrow').mockImplementation(() => {
          throw error;
        });
      if (stage === 'insert')
        vi.spyOn(f.history, 'insert').mockImplementation(() => {
          throw error;
        });
      if (stage === 'emit')
        vi.spyOn(f.bus, 'emit').mockImplementation(() => {
          throw error;
        });
      let caught: unknown;
      try {
        f.run();
      } catch (err) {
        caught = err;
      }
      expect(caught).toBe(error);
      const saved = f.reopen();
      expect(saved.pod.lastValidationResult).toEqual(f.result);
      expect(saved.history).toHaveLength(stage === 'emit' ? 1 : 0);
      expect(saved.events).toEqual([]);
      expect(saved.pod.phaseTokenUsage?.review?.inputTokens).toBe(stage === 'read' ? 5 : 15);
    },
  );
});
