import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb } from '../test-utils/mock-helpers.js';
import { computeMemoryEffectivenessAnalytics } from './memory-effectiveness-aggregator.js';
import { createMemoryRepository } from './memory-repository.js';
import { createMemoryUsageRepository } from './memory-usage-repository.js';

function insertProfile(db: Database.Database, name = 'test-profile'): void {
  db.prepare(
    `INSERT INTO profiles (name, repo_url, build_command, start_command)
     VALUES (@name, 'https://github.com/org/repo', 'npm run build', 'npm start')`,
  ).run({ name });
}

function insertPod(
  db: Database.Database,
  opts: {
    id: string;
    profileName?: string;
    createdAt?: string;
    completedAt?: string;
    reworkCount?: number;
    prFixAttempts?: number;
    costUsd?: number;
    status?: string;
  },
): void {
  db.prepare(
    `INSERT INTO pods (
      id, profile_name, task, status, model, runtime, execution_target, branch,
      user_id, max_validation_attempts, skip_validation, output_mode, agent_mode,
      output_target, validate, promotable, created_at, completed_at, rework_count,
      pr_fix_attempts, cost_usd
    ) VALUES (
      @id, @profileName, 'task', @status, 'claude-opus-4-7', 'claude', 'local', @id,
      'user-1', 3, 0, 'pr', 'auto', 'pr', 1, 0, @createdAt, @completedAt,
      @reworkCount, @prFixAttempts, @costUsd
    )`,
  ).run({
    id: opts.id,
    profileName: opts.profileName ?? 'test-profile',
    status: opts.status ?? 'complete',
    createdAt: opts.createdAt ?? new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
    completedAt: opts.completedAt ?? new Date().toISOString(),
    reworkCount: opts.reworkCount ?? 0,
    prFixAttempts: opts.prFixAttempts ?? 0,
    costUsd: opts.costUsd ?? 0,
  });
}

function insertQuality(
  db: Database.Database,
  opts: { podId: string; score: number; validationPassed: boolean; prFixAttempts?: number },
): void {
  db.prepare(
    `INSERT INTO pod_quality_scores (
      pod_id, score, read_count, edit_count, read_edit_ratio, edits_without_prior_read,
      user_interrupts, edit_churn_count, tells_count, pr_fix_attempts, validation_passed,
      input_tokens, output_tokens, cost_usd, runtime, profile_name, model, final_status,
      completed_at, computed_at
    ) VALUES (
      @podId, @score, 1, 1, 1, 0, 0, 0, 0, @prFixAttempts, @validationPassed,
      100, 50, 0.1, 'claude', 'test-profile', 'claude-opus-4-7', 'complete',
      datetime('now'), datetime('now')
    )`,
  ).run({
    podId: opts.podId,
    score: opts.score,
    validationPassed: opts.validationPassed ? 1 : 0,
    prFixAttempts: opts.prFixAttempts ?? 0,
  });
}

describe('computeMemoryEffectivenessAnalytics', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
    insertProfile(db);
  });

  afterEach(() => {
    db.close();
  });

  it('returns an empty analytics cohort', () => {
    const result = computeMemoryEffectivenessAnalytics(db, 30);

    expect(result.summary.selectedCount).toBe(0);
    expect(result.impact).toMatchObject({ cohortSize: 0, comparisonCohortSize: 0 });
    expect(result.topMemories).toHaveLength(0);
  });

  it('compares selected/injected memory pods against same-profile pods without memory', () => {
    const memoryRepo = createMemoryRepository(db);
    const usageRepo = createMemoryUsageRepository(db);
    memoryRepo.insert({
      id: 'mem-1',
      scope: 'profile',
      scopeId: 'test-profile',
      path: '/gotchas/build.md',
      content: 'Run generated build first.',
      rationale: null,
      kind: 'gotcha',
      tags: [],
      appliesWhen: null,
      avoidWhen: null,
      confidence: 0.8,
      sourceEvidence: [],
      impactSummary: 'Avoids generated-file failures.',
      approved: true,
      createdByPodId: null,
    });

    insertPod(db, {
      id: 'with-memory',
      reworkCount: 0,
      prFixAttempts: 0,
      costUsd: 0.1,
    });
    insertPod(db, {
      id: 'without-memory',
      reworkCount: 2,
      prFixAttempts: 1,
      costUsd: 0.5,
    });
    insertQuality(db, { podId: 'with-memory', score: 90, validationPassed: true });
    insertQuality(db, {
      podId: 'without-memory',
      score: 70,
      validationPassed: false,
      prFixAttempts: 1,
    });
    db.prepare(
      `INSERT INTO escalations (id, pod_id, type, payload)
       VALUES ('esc-1', 'without-memory', 'human', '{}')`,
    ).run();

    usageRepo.record({
      id: 'usage-selected',
      memoryId: 'mem-1',
      podId: 'with-memory',
      kind: 'selected',
      outcome: null,
      reason: null,
      relevanceReason: 'matched task',
    });
    usageRepo.record({
      id: 'usage-injected',
      memoryId: 'mem-1',
      podId: 'with-memory',
      kind: 'injected',
      outcome: null,
      reason: null,
      relevanceReason: 'selected',
    });
    usageRepo.record({
      id: 'usage-read',
      memoryId: 'mem-1',
      podId: 'with-memory',
      kind: 'read',
      outcome: null,
      reason: null,
      relevanceReason: null,
    });
    usageRepo.record({
      id: 'usage-applied',
      memoryId: 'mem-1',
      podId: 'with-memory',
      kind: 'summary_reported',
      outcome: 'applied',
      reason: 'Used it.',
      relevanceReason: null,
    });

    const result = computeMemoryEffectivenessAnalytics(db, 30);

    expect(result.summary).toMatchObject({
      selectedCount: 1,
      injectedCount: 1,
      readCount: 1,
      appliedCount: 1,
    });
    expect(result.impact).toMatchObject({
      cohortSize: 1,
      comparisonCohortSize: 1,
      qualityDelta: 20,
      validationFailureDelta: -1,
      fixAttemptDelta: -1,
      escalationDelta: -1,
      costDeltaUsd: -0.4,
      reworkDelta: -2,
      firstPassRateDelta: 1,
    });
    expect(result.topMemories[0]).toMatchObject({
      memoryId: 'mem-1',
      selectedCount: 1,
      injectedCount: 1,
      appliedCount: 1,
    });
  });
});
