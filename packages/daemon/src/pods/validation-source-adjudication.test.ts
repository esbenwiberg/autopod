import type { ReviewBatchResult, ValidationResult } from '@autopod/shared';
import { describe, expect, it } from 'vitest';
import {
  createMockProfileStore,
  createPassingValidationResult,
  createTestDb,
  insertTestProfile,
} from '../test-utils/mock-helpers.js';
import { createPodRepository } from './pod-repository.js';

function batch(id: string): ReviewBatchResult {
  return {
    id,
    diffHash: 'diff',
    reviewedHead: 'a'.repeat(40),
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
    quality: 'healthy',
  };
}

describe('native source evidence for independently adjudicated review', () => {
  it.each([
    'unchanged',
    'before-drift',
    'after-drift',
    'foreign-review-head',
    'foreign-primary-head',
    'missing-primary-head',
    'failed-test',
    'foreign-pod',
    'override',
    'missing-original',
    'unverified-review',
  ] as const)('records new proof only for unchanged healthy native evidence: %s', (scenario) => {
    const db = createTestDb();
    try {
      insertTestProfile(db);
      const repo = createPodRepository(db);
      repo.insert({
        id: 'adjudicated',
        profileName: 'test-profile',
        task: 'Confirm the current retry findings',
        model: 'model',
        runtime: 'codex',
        branch: 'feature',
        userId: 'operator',
        status: 'validated',
        executionTarget: 'local',
        maxValidationAttempts: 3,
        skipValidation: false,
        outputMode: 'pr',
      });
      repo.update('adjudicated', { containerId: 'container', worktreePath: '/tmp/source' });
      const profile = createMockProfileStore(db).get('test-profile');
      const pod = repo.getOrThrow('adjudicated');
      const sources = repo.validationSources!;
      const retries = repo.taskRetries!;
      const source = { head: 'a'.repeat(40), tree: 'b'.repeat(40) };
      const pass: ValidationResult = {
        ...createPassingValidationResult(pod.id),
        taskReview: {
          status: 'pass',
          reasoning: 'Native review completed',
          issues: [],
          model: 'reviewer',
          screenshots: [],
          diff: '+change',
        },
      };
      const original: ValidationResult = {
        ...pass,
        overall: 'fail',
        taskReview: {
          ...pass.taskReview,
          status: 'fail',
          issues: ['An unconfirmed retry finding'],
          reviewBatch: batch('primary'),
        },
      };
      if (scenario === 'foreign-primary-head')
        original.taskReview!.reviewBatch!.reviewedHead = 'c'.repeat(40);
      if (scenario === 'missing-primary-head') original.taskReview!.reviewBatch!.reviewedHead = '';
      if (scenario === 'failed-test')
        original.test = { status: 'fail', stdout: 'Real failing test', duration: 1 };
      const independent: ValidationResult = {
        ...pass,
        taskReview: { ...pass.taskReview, reviewBatch: batch('independent') },
      };
      if (scenario === 'foreign-review-head')
        independent.taskReview!.reviewBatch!.reviewedHead = 'c'.repeat(40);
      if (scenario === 'foreign-pod') independent.podId = 'other';
      if (scenario === 'unverified-review')
        independent.infrastructureFailure = {
          phase: 'review',
          code: 'EXEC_EXIT_UNVERIFIED',
          message: 'Unknown review process',
          retryable: false,
        };
      const effective: ValidationResult = {
        ...original,
        overall: 'pass',
        taskReview: {
          ...pass.taskReview,
          reviewBatch: {
            ...batch('primary'),
            adjudication: {
              kind: 'recurrence-hoist',
              originalReviewBatchId: 'primary',
              candidateFindingIds: ['finding'],
              confirmedFindingIds: [],
            },
          },
        },
      };
      const attempt = retries.admit(
        pod.id,
        pod.lifecycleGeneration,
        { source: null, contract: null, commands: null, environment: null, implementation: null },
        'a'.repeat(64),
        [],
      );
      retries.start(attempt.id);
      const originalId = sources.begin(pod, profile, source, attempt.id);
      if (scenario !== 'missing-original')
        sources.finish(originalId, pod, profile, source, original);
      retries.finish(attempt.id, 'nonretryable', 1);
      repo.update(pod.id, { lastValidationResult: original });
      expect(() => sources.checked(repo.getOrThrow(pod.id), profile)).toThrow();
      const before = scenario === 'before-drift' ? { ...source, head: 'c'.repeat(40) } : source;
      const after = scenario === 'after-drift' ? { ...source, tree: 'd'.repeat(40) } : source;
      const current =
        scenario === 'override'
          ? { ...repo.getOrThrow(pod.id), skipValidation: true }
          : repo.getOrThrow(pod.id);
      sources.adjudicate(current, profile, before, after, original, independent, effective);
      repo.update(pod.id, { lastValidationResult: effective });
      if (scenario === 'unchanged') {
        const checked = sources.checked(repo.getOrThrow(pod.id), profile);
        expect(checked).toMatchObject(source);
        expect(checked.validationId).not.toBe(originalId);
        const originalResult = db
          .prepare('SELECT result FROM validation_source_results WHERE intent_id=?')
          .get(originalId) as { result: string };
        expect(JSON.parse(originalResult.result).overall).toBe('fail');
        expect(retries.state(pod.id).latest?.outcome).toBe('nonretryable');
      } else expect(() => sources.checked(repo.getOrThrow(pod.id), profile)).toThrow();
    } finally {
      db.close();
    }
  });
});
