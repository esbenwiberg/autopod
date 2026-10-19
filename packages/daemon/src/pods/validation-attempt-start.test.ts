import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Pod, PodOptions } from '@autopod/shared';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PodExecutionSettings } from '../interfaces/pod-execution-settings.js';
import {
  createMockProfileStore,
  createTestDb,
  insertTestProfile,
  logger,
} from '../test-utils/mock-helpers.js';
import { createEventBus } from './event-bus.js';
import { createEventRepository } from './event-repository.js';
import { createPodRepository } from './pod-repository.js';
import { validateTransition } from './state-machine.js';
import { createValidationAttemptStart } from './validation-attempt-start.js';

afterEach(() => vi.restoreAllMocks());

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

interface Inputs {
  status?: Pod['status'];
  count?: number;
  marker?: 'wake' | 'restart';
  suite?: NonNullable<PodOptions['validationSuite']>;
  validate?: boolean;
  reworks?: number;
}

function fixture(input: Inputs = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'validation-attempt-start-'));
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
  const events = createEventRepository(db);
  const bus = createEventBus(events, logger);
  repo.insert({
    id: 'worker',
    profileName: 'test-profile',
    task: 'Start validation',
    status: input.status ?? 'running',
    model: 'model',
    runtime: 'codex',
    executionTarget: 'local',
    branch: 'feature',
    userId: 'operator',
    maxValidationAttempts: 7,
    skipValidation: false,
    outputMode: 'pr',
    options: {
      agentMode: 'auto',
      output: 'pr',
      validate: input.validate ?? true,
      validationSuite: input.suite,
    },
  });
  repo.update('worker', {
    validationAttempts: input.count ?? 2,
    lastRecoveryTrigger: input.marker ?? null,
    reworkCount: input.reworks ?? 0,
  });
  const profile = createMockProfileStore(db).get('test-profile');
  const order: string[] = [];
  const guard = vi.fn((_id: string) => {
    order.push('guard');
  });
  const scan = vi.fn(async (_pod: Pod, _profile: PodExecutionSettings) => {
    order.push('scan');
  });
  const transition = vi.fn((pod: Pod, to: 'validating') => {
    validateTransition(pod.id, pod.status, to);
    repo.update(pod.id, { status: to });
    order.push('transition');
    bus.emit({
      type: 'pod.status_changed',
      timestamp: new Date().toISOString(),
      podId: pod.id,
      previousStatus: pod.status,
      newStatus: to,
    });
    return repo.getOrThrow(pod.id);
  });
  const suite = vi.fn((pod: Pod): NonNullable<PodOptions['validationSuite']> => {
    order.push('suite');
    return pod.options.validationSuite ?? (pod.options.validate === false ? 'off' : 'full');
  });
  const activity = vi.fn((_id: string, _message: string) => {
    order.push('activity');
  });
  bus.subscribe((event) => {
    if (event.type === 'pod.validation_started') order.push('start-event');
  });
  const dependencies = {
    assertGuidanceCollected: guard,
    runPushCheckpointScan: scan,
    podRepo: repo,
    transition,
    eventBus: bus,
    getPodValidationSuite: suite,
    emitActivityStatus: activity,
  };
  const module = createValidationAttemptStart(dependencies);
  return {
    repo,
    events,
    bus,
    profile,
    order,
    guard,
    scan,
    transition,
    suite,
    activity,
    dependencies,
    ...module,
    run: (fromTerminal = false, pod = repo.getOrThrow('worker')) =>
      module.startValidationAttempt(pod, profile, fromTerminal),
    failStartPersistence() {
      db.exec(
        "CREATE TRIGGER reject_validation_start BEFORE INSERT ON events WHEN NEW.type = 'pod.validation_started' BEGIN SELECT RAISE(ABORT, 'start persistence rejected'); END",
      );
    },
    reopen() {
      db.close();
      db = new Database(file);
      db.pragma('foreign_keys = ON');
      expect(db.pragma('integrity_check', { simple: true })).toBe('ok');
      expect(db.pragma('foreign_key_check')).toEqual([]);
      return {
        pod: createPodRepository(db).getOrThrow('worker'),
        events: createEventRepository(db),
      };
    },
    close() {
      db.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

describe('validation attempt start persisted effects', () => {
  const accounting: Array<Inputs & { name: string; attempt: number; terminal?: boolean }> = [
    { name: 'normal zero', count: 0, attempt: 1 },
    { name: 'normal nonzero', count: 2, attempt: 3 },
    ...(['failed', 'review_required', 'killed', 'validated'] as const).map((status) => ({
      name: status,
      status,
      count: 4,
      attempt: 1,
      terminal: true,
    })),
    { name: 'wake', marker: 'wake', count: 2, attempt: 2 },
    {
      name: 'terminal wake',
      status: 'failed',
      marker: 'wake',
      count: 4,
      attempt: 0,
      terminal: true,
    },
    { name: 'restart', marker: 'restart', count: 2, attempt: 3 },
  ];
  it.each(accounting)('$name persists the selected attempt and start event', async (c) => {
    const f = fixture(c);
    try {
      expect(f.order).toEqual([]);
      expect(f.guard).not.toHaveBeenCalled();
      expect(f.events.countForSession('worker', 'pod.validation_started')).toBe(0);
      const original = f.repo.getOrThrow('worker');
      const result = await f.run(c.terminal ?? false, original);
      expect(result.attempt).toBe(c.attempt);
      expect(result.validationSuite).toBe('full');
      expect(result.s1).toBe(f.transition.mock.results[0]?.value);
      expect(result.s1.validationAttempts).toBe(c.terminal ? 0 : c.count);
      expect(result.s1.lastRecoveryTrigger).toBe(c.marker ?? null);
      expect(f.scan).toHaveBeenCalledWith(original, f.profile);
      expect(f.order).toEqual(['guard', 'scan', 'transition', 'start-event', 'suite', 'activity']);
      const persisted = f.reopen();
      expect(persisted.pod).toMatchObject({
        status: 'validating',
        validationAttempts: c.attempt,
        lastRecoveryTrigger: c.marker === 'wake' ? null : (c.marker ?? null),
      });
      const starts = persisted.events.getForSession('worker', { type: 'pod.validation_started' });
      expect(starts).toHaveLength(1);
      expect(starts[0]?.payload).toMatchObject({
        podId: 'worker',
        attempt: c.attempt,
        timestamp: expect.any(String),
      });
    } finally {
      f.close();
    }
  });

  it.each([
    ...(['off', 'thin', 'thin-with-facts', 'deterministic', 'full', 'custom'] as const).map(
      (suite) => ({ suite, validate: true, expected: suite }),
    ),
    { suite: undefined, validate: false, expected: 'off' },
    { suite: 'full' as const, validate: false, expected: 'full' },
  ])('preserves suite $expected and rework activity', async (c) => {
    const f = fixture({ ...c, reworks: 3 });
    try {
      const result = await f.run();
      expect(result.validationSuite).toBe(c.expected);
      expect(f.activity).toHaveBeenCalledWith(
        'worker',
        `Starting ${c.expected} validation (rework 3, attempt 3/7)…`,
      );
      expect(f.suite.mock.calls[0]?.[0]).toBe(result.s1);
      expect(f.reopen().pod.validationAttempts).toBe(3);
    } finally {
      f.close();
    }
  });

  it.each([false, true])(
    'returns the exact transition snapshot before the wake/counter update, wake=%s',
    async (wake) => {
      const f = fixture({ marker: wake ? 'wake' : undefined });
      try {
        const body = f.transition.getMockImplementation();
        if (!body) throw new Error('Missing transition');
        f.transition.mockImplementationOnce((p, to) => ({
          ...body(p, to),
          task: 'distinct returned snapshot',
        }));
        const result = await f.run();
        expect(result.s1).toBe(f.transition.mock.results[0]?.value);
        expect(result.s1).toMatchObject({
          task: 'distinct returned snapshot',
          validationAttempts: 2,
          lastRecoveryTrigger: wake ? 'wake' : null,
        });
        expect(f.suite.mock.calls[0]?.[0]).toBe(result.s1);
        expect(f.reopen().pod).toMatchObject({
          task: 'Start validation',
          validationAttempts: wake ? 2 : 3,
          lastRecoveryTrigger: null,
        });
      } finally {
        f.close();
      }
    },
  );

  it('holds the scan before resets, status changes or start publication', async () => {
    const f = fixture({ status: 'failed', count: 4 });
    const entered = deferred();
    const release = deferred();
    let operation: ReturnType<typeof f.run> | undefined;
    try {
      const body = f.scan.getMockImplementation();
      if (!body) throw new Error('Missing scan');
      f.scan.mockImplementationOnce(async (...args) => {
        f.order.push('scan-held');
        entered.resolve();
        await release.promise;
        await body(...args);
      });
      operation = f.run(true);
      await entered.promise;
      expect(f.repo.getOrThrow('worker')).toMatchObject({
        status: 'failed',
        validationAttempts: 4,
      });
      expect(f.order).toEqual(['guard', 'scan-held']);
      expect(f.events.countForSession('worker', 'pod.validation_started')).toBe(0);
      release.resolve();
      expect((await operation).attempt).toBe(1);
      expect(f.reopen().pod.status).toBe('validating');
    } finally {
      release.resolve();
      await Promise.allSettled(operation ? [operation] : []);
      f.close();
    }
  });

  it.each([
    'guard',
    'scan',
    'reset',
    'transition',
    'counter',
    'start-event',
    'suite',
    'activity',
  ] as const)('keeps %s failure identity and preceding durable effects', async (stage) => {
    const f = fixture({ status: 'failed', count: 4 });
    const fault = new Error(`${stage} fault`);
    try {
      if (stage === 'guard')
        f.guard.mockImplementationOnce(() => {
          throw fault;
        });
      if (stage === 'scan') f.scan.mockRejectedValueOnce(fault);
      if (stage === 'transition')
        f.transition.mockImplementationOnce(() => {
          throw fault;
        });
      if (stage === 'suite')
        f.suite.mockImplementationOnce(() => {
          throw fault;
        });
      if (stage === 'activity')
        f.activity.mockImplementationOnce(() => {
          throw fault;
        });
      if (stage === 'reset' || stage === 'counter') {
        const update = f.repo.update.bind(f.repo);
        vi.spyOn(f.repo, 'update').mockImplementation((id, u) => {
          if (u.validationAttempts === (stage === 'reset' ? 0 : 1)) throw fault;
          return update(id, u);
        });
      }
      if (stage === 'start-event') {
        const emit = f.bus.emit.bind(f.bus);
        vi.spyOn(f.bus, 'emit').mockImplementation((event) => {
          if (event.type === 'pod.validation_started') throw fault;
          return emit(event);
        });
      }
      await expect(f.run(true)).rejects.toBe(fault);
      const persisted = f.reopen();
      const beforeTransition = ['guard', 'scan', 'reset', 'transition'].includes(stage);
      expect(persisted.pod.status).toBe(beforeTransition ? 'failed' : 'validating');
      expect(persisted.pod.validationAttempts).toBe(
        ['guard', 'scan', 'reset'].includes(stage)
          ? 4
          : stage === 'transition' || stage === 'counter'
            ? 0
            : 1,
      );
      expect(persisted.events.countForSession('worker', 'pod.validation_started')).toBe(
        stage === 'suite' || stage === 'activity' ? 1 : 0,
      );
      if (stage !== 'activity') expect(f.activity).not.toHaveBeenCalled();
    } finally {
      f.close();
    }
  });

  it('preserves writes when actual SQLite start-event persistence rejects', async () => {
    const f = fixture();
    try {
      f.failStartPersistence();
      await expect(f.run()).rejects.toThrow('start persistence rejected');
      expect(f.activity).not.toHaveBeenCalled();
      const persisted = f.reopen();
      expect(persisted.pod).toMatchObject({ status: 'validating', validationAttempts: 3 });
      expect(persisted.events.countForSession('worker', 'pod.validation_started')).toBe(0);
      expect(persisted.events.countForSession('worker', 'pod.status_changed')).toBe(1);
    } finally {
      f.close();
    }
  });

  it('keeps real event-bus subscriber failures distinct from persistence failures', async () => {
    const f = fixture();
    try {
      f.bus.subscribe((event) => {
        if (event.type === 'pod.validation_started') throw new Error('subscriber fault');
      });
      expect((await f.run()).attempt).toBe(3);
      const persisted = f.reopen();
      expect(persisted.events.countForSession('worker', 'pod.validation_started')).toBe(1);
      expect(f.activity).toHaveBeenCalledOnce();
    } finally {
      f.close();
    }
  });

  it('passes captured scan inputs, then uses the transition reload after a held scan', async () => {
    const f = fixture();
    const entered = deferred();
    const release = deferred();
    let operation: ReturnType<typeof f.run> | undefined;
    try {
      const original = f.repo.getOrThrow('worker');
      const body = f.scan.getMockImplementation();
      if (!body) throw new Error('Missing scan');
      f.scan.mockImplementationOnce(async (...args) => {
        entered.resolve();
        await release.promise;
        await body(...args);
      });
      operation = f.run(false, original);
      await entered.promise;
      f.repo.update('worker', {
        validationAttempts: 6,
        lastRecoveryTrigger: 'wake',
        options: { ...original.options, validationSuite: 'custom' },
      });
      release.resolve();
      const result = await operation;
      expect(f.scan).toHaveBeenCalledWith(original, f.profile);
      expect(original.validationAttempts).toBe(2);
      expect(result).toMatchObject({
        attempt: 6,
        validationSuite: 'custom',
        s1: { validationAttempts: 6, lastRecoveryTrigger: 'wake' },
      });
      expect(f.reopen().pod).toMatchObject({ validationAttempts: 6, lastRecoveryTrigger: null });
    } finally {
      release.resolve();
      await Promise.allSettled(operation ? [operation] : []);
      f.close();
    }
  });
});
