import type { AgentEvent, ProviderAttempt, ProviderFailureClassification } from '@autopod/shared';
import pino from 'pino';
import { describe, expect, it } from 'vitest';
import { createTestDb, insertTestProfile } from '../test-utils/mock-helpers.js';
import { createEventBus } from './event-bus.js';
import { createEventRepository } from './event-repository.js';
import { createPodRepository, type PodUpdates } from './pod-repository.js';
import {
  assessPreUsageProviderRefusal,
  assessZeroWorkProviderAccountFailure,
} from './zero-work-failure.js';

const POD_ID = 'zero-work-pod';
const attempt = (usage: Partial<ProviderAttempt> = {}) =>
  ({ inputTokens: 0, outputTokens: 0, costUsd: 0, ...usage }) as ProviderAttempt;

function fixture(updates: PodUpdates = {}, attempts = [attempt()]) {
  const db = createTestDb();
  insertTestProfile(db);
  const podRepo = createPodRepository(db);
  const eventRepo = createEventRepository(db);
  const eventBus = createEventBus(eventRepo, pino({ level: 'silent' }));
  podRepo.insert({
    id: POD_ID,
    profileName: 'test-profile',
    task: 'Canary',
    status: 'failed',
    model: 'opus',
    runtime: 'claude',
    executionTarget: 'local',
    branch: 'autopod/zero-work-pod',
    userId: 'user-1',
    maxValidationAttempts: 3,
    skipValidation: false,
    outputMode: 'pr',
  });
  podRepo.update(POD_ID, {
    failureReason: 'Provider account unavailable: Your workspace is out of credits.',
    ...updates,
  });
  const assess = () =>
    assessZeroWorkProviderAccountFailure(podRepo.getOrThrow(POD_ID), {
      eventRepo,
      providerAttemptRepo: { list: () => attempts },
    });
  const timestamp = new Date().toISOString();
  const events: Record<'status' | 'error' | 'tool_use' | 'reasoning', AgentEvent> = {
    status: { type: 'status', timestamp, message: 'Claude pod initialized' },
    error: { type: 'error', timestamp, message: 'Account refused', fatal: true },
    tool_use: { type: 'tool_use', timestamp, tool: 'Bash', input: {} },
    reasoning: { type: 'reasoning', timestamp, text: 'thinking' },
  };
  const activity = (type: keyof typeof events) =>
    eventBus.emit({ type: 'pod.agent_activity', timestamp, podId: POD_ID, event: events[type] });
  const assessRefusal = (
    classification: ProviderFailureClassification = OUT_OF_CREDITS,
    taskRunCount = 1,
    evidence: { events?: boolean } = {},
  ) =>
    assessPreUsageProviderRefusal(podRepo.getOrThrow(POD_ID), classification, {
      taskRunCount,
      eventRepo: evidence.events === false ? undefined : eventRepo,
      providerAttemptRepo: { list: () => attempts },
    });
  return { assess, assessRefusal, activity };
}

const OUT_OF_CREDITS: ProviderFailureClassification = {
  category: 'auth',
  definitive: true,
  sanitizedMessage: 'Your workspace is out of credits.',
  retryAfter: null,
};

describe('assessZeroWorkProviderAccountFailure', () => {
  it('qualifies only status and error activity after a provider account refusal', () => {
    const f = fixture();
    f.activity('status');
    f.activity('error');
    expect(f.assess()).toEqual({ qualifies: true });
  });

  it.each<[string, PodUpdates]>([
    ['agent failure', { failureReason: 'Agent failed: Codex process exited with code 1' }],
    ['pod usage', { inputTokens: 12 }],
    ['pod cost', { costUsd: 0.01 }],
    ['commits', { commitCount: 1 }],
    ['source changes', { filesChanged: 1 }],
    ['rework', { reworkCount: 1 }],
    ['recovery', { recoveryCount: 1 }],
    ['recovery worktree', { recoveryWorktreePath: '/tmp/worktree' }],
    ['delivery', { prUrl: 'https://example.invalid/pr/1' }],
    ['escalation', { escalationCount: 1 }],
  ])('keeps resources with recorded %s', (_name, updates) => {
    expect(fixture(updates).assess().qualifies).toBe(false);
  });

  it.each(['tool_use', 'reasoning'] as const)('keeps resources after %s activity', (type) => {
    const f = fixture();
    f.activity(type);
    expect(f.assess()).toEqual({ qualifies: false, reason: 'agent activity recorded' });
  });

  it('keeps resources when any provider attempt recorded usage', () => {
    expect(fixture({}, [attempt(), attempt({ outputTokens: 3 })]).assess()).toEqual({
      qualifies: false,
      reason: 'provider attempt usage recorded',
    });
  });
});

describe('assessPreUsageProviderRefusal', () => {
  it('qualifies a definitive account refusal with no usage or agent work on the only run', () => {
    const f = fixture({ status: 'paused' });
    f.activity('status');
    f.activity('error');
    expect(f.assessRefusal()).toEqual({ qualifies: true });
  });

  it('qualifies a definitive quota stop with no usage', () => {
    const f = fixture({ status: 'paused' });
    expect(
      f.assessRefusal({
        category: 'quota_exhausted',
        definitive: true,
        sanitizedMessage: 'quota',
        retryAfter: null,
      }),
    ).toEqual({ qualifies: true });
  });

  it.each([
    [
      'non-definitive',
      { ...OUT_OF_CREDITS, definitive: false },
      1,
      'provider failure is not definitive',
    ],
    [
      'other auth failure',
      { ...OUT_OF_CREDITS, sanitizedMessage: 'Authentication failed' },
      1,
      'not a provider quota or account refusal',
    ],
    ['second run', OUT_OF_CREDITS, 2, 'more than one worker run recorded for this pod'],
  ] as const)('keeps the block for a %s', (_name, classification, runs, reason) => {
    const f = fixture({ status: 'paused' });
    expect(f.assessRefusal(classification, runs)).toEqual({ qualifies: false, reason });
  });

  it('keeps the block when usage, attempt usage or agent activity was recorded', () => {
    expect(fixture({ inputTokens: 1 }).assessRefusal()).toEqual({
      qualifies: false,
      reason: 'usage recorded',
    });
    expect(fixture({}, [attempt({ outputTokens: 3 })]).assessRefusal()).toEqual({
      qualifies: false,
      reason: 'provider attempt usage recorded',
    });
    const worked = fixture();
    worked.activity('reasoning');
    expect(worked.assessRefusal()).toEqual({ qualifies: false, reason: 'agent activity recorded' });
    expect(fixture().assessRefusal(OUT_OF_CREDITS, 1, { events: false })).toEqual({
      qualifies: false,
      reason: 'agent activity evidence unavailable',
    });
  });

  it('does not touch already settled accounting', () => {
    expect(fixture({ tokenTelemetryAccuracy: 'complete' }).assessRefusal()).toEqual({
      qualifies: false,
      reason: 'token accounting already settled',
    });
  });
});
