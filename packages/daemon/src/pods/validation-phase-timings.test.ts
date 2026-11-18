import type { SystemEvent } from '@autopod/shared';
import { afterEach, expect, it, vi } from 'vitest';
import { createTestDb, insertTestProfile } from '../test-utils/mock-helpers.js';
import { createEventRepository } from './event-repository.js';
import { createPodRepository } from './pod-repository.js';
import {
  createValidationPhaseTimings,
  latestValidationPhase,
  type ValidationTimingContext,
  validationPhaseTimingKey,
} from './validation-phase-timings.js';
import { createValidationProgress } from './validation-progress.js';

const context: ValidationTimingContext = {
  config: {
    podId: 'one',
    containerId: 'local-container',
    buildCommand: 'build',
    testCommand: 'test:all',
    startCommand: '',
    healthPath: '/',
    healthTimeout: 120,
    smokePages: [],
    previewUrl: '',
    attempt: 1,
    task: '',
    diff: '',
    executionTarget: 'local',
  },
  profile: {
    name: 'example',
    repoUrl: 'https://example.test/owner/repo',
    template: null,
    warmImageTag: 'image-v1',
    containerMemoryGb: 4,
    executionTarget: 'local',
  },
};

afterEach(() => vi.useRealTimers());

it('uses one sample, then a bounded median of the most recent samples', () => {
  const db = createTestDb();
  const timings = createValidationPhaseTimings(db);
  expect(timings.estimate('test')).toBeUndefined();
  timings.record('test', 300_000);
  expect(timings.estimate('test')).toEqual({ durationMs: 300_000, sampleCount: 1 });
  timings.record('test', 360_000);
  expect(timings.estimate('test')).toEqual({ durationMs: 330_000, sampleCount: 2 });
  for (let i = 0; i < 7; i++) timings.record('test', 90_000 + i * 1_000);
  expect(timings.estimate('test')).toEqual({ durationMs: 93_000, sampleCount: 7 });
  db.close();
});

it('separates test commands, suites, and execution environments, not individual pods', () => {
  const key = validationPhaseTimingKey(context, 'test');
  expect(key).toBeDefined();
  for (const config of [
    { testCommand: 'test:smoke' },
    { executionTarget: 'sandbox' },
    { validationSuite: 'thin' },
    { buildWorkDir: 'packages/app' },
  ] as const) {
    expect(
      validationPhaseTimingKey({ ...context, config: { ...context.config, ...config } }, 'test'),
    ).not.toBe(key);
  }
  expect(
    validationPhaseTimingKey(
      {
        ...context,
        profile: { ...context.profile, warmImageTag: 'image-v2' },
      },
      'test',
    ),
  ).not.toBe(key);
  expect(
    validationPhaseTimingKey(
      {
        ...context,
        config: { ...context.config, podId: 'two', containerId: 'other', attempt: 2 },
      },
      'test',
    ),
  ).toBe(key);
  expect(validationPhaseTimingKey(context, 'review')).toBeUndefined();
});

it('learns from real passes, and hydrates the original start and estimate for a later pod', () => {
  vi.useFakeTimers({ toFake: ['Date', 'performance'] });
  const db = createTestDb();
  insertTestProfile(db);
  const podRepo = createPodRepository(db);
  for (const id of ['one', 'two']) {
    podRepo.insert({
      id,
      profileName: 'test-profile',
      task: 'Validation timing',
      status: 'validating',
      model: 'model',
      runtime: 'claude',
      executionTarget: 'local',
      branch: `work/${id}`,
      userId: 'operator',
      maxValidationAttempts: 3,
      skipValidation: false,
      outputMode: 'pr',
    });
  }
  const eventRepo = createEventRepository(db);
  const timing = createValidationPhaseTimings(db);
  const eventBus = { emit: (event: SystemEvent) => eventRepo.insert(event) };
  const { buildPhaseEventCallbacks } = createValidationProgress({ eventBus, timing });

  const first = buildPhaseEventCallbacks('one', context);
  first.onPhaseStarted('test');
  expect(
    latestValidationPhase({ id: 'one', status: 'validating' }, eventRepo)?.active?.estimate,
  ).toBeUndefined();
  vi.advanceTimersByTime(300_000);
  first.onPhaseCompleted('test', 'pass', { duration: 299_000 });

  for (const [status, result] of [
    ['pass', { duration: 300_000, reusedEvidence: {} }],
    ['pass', { duration: 0 }],
    ['skip', { duration: 8_000 }],
    ['fail', { duration: 3_000 }],
  ] as const) {
    first.onPhaseStarted('test');
    vi.advanceTimersByTime(3_000);
    first.onPhaseCompleted('test', status, result);
  }

  const second = buildPhaseEventCallbacks('two', context);
  const startedAt = new Date().toISOString();
  second.onPhaseStarted('test');
  vi.advanceTimersByTime(134_000);
  const pod = { id: 'two', status: 'validating' };
  const snapshot = latestValidationPhase(pod, eventRepo);
  expect(snapshot?.active).toEqual({
    phase: 'test',
    startedAt,
    estimate: { durationMs: 300_000, sampleCount: 1 },
  });
  expect(latestValidationPhase({ ...pod, status: 'complete' }, eventRepo)?.active).toBeNull();

  second.onPhaseCompleted('test', 'pass', { duration: 134_000 });
  const completed = latestValidationPhase(pod, eventRepo);
  expect(completed?.active).toBeNull();
  expect(completed?.eventId).toBeGreaterThan(snapshot?.eventId ?? Infinity);
  db.close();
});
