import type { PodQualityScore } from '@autopod/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { createTestDb } from '../test-utils/mock-helpers.js';
import {
  type QualityScoreRepository,
  createQualityScoreRepository,
} from './quality-score-repository.js';

function baseScore(overrides: Partial<PodQualityScore> = {}): PodQualityScore {
  const now = new Date().toISOString();
  return {
    podId: 'pod-1',
    score: 85,
    readCount: 10,
    editCount: 2,
    readEditRatio: 5,
    editsWithoutPriorRead: 0,
    userInterrupts: 0,
    editChurnCount: 0,
    tellsCount: 0,
    prFixAttempts: 0,
    validationPassed: null,
    inputTokens: 1000,
    outputTokens: 500,
    costUsd: 0.12,
    runtime: 'claude',
    profileName: 'test-profile',
    model: 'claude-opus-4-7',
    finalStatus: 'complete',
    completedAt: now,
    computedAt: now,
    ...overrides,
  };
}

describe('QualityScoreRepository', () => {
  let repo: QualityScoreRepository;

  beforeEach(() => {
    const db = createTestDb();
    // Foreign key from pod_quality_scores → pods requires a matching pod row.
    // Disable FKs for these focused repo tests; integration coverage in the
    // recorder test exercises the real relationship.
    db.pragma('foreign_keys = OFF');
    repo = createQualityScoreRepository(db);
  });

  it('inserts and retrieves a score by pod id', () => {
    const row = baseScore();
    repo.insert(row);
    expect(repo.get('pod-1')).toEqual(row);
  });

  it('returns null for an unknown pod', () => {
    expect(repo.get('missing')).toBeNull();
  });

  it('overwrites on conflict so fix-pod re-runs update in place', () => {
    repo.insert(baseScore({ score: 40 }));
    repo.insert(baseScore({ score: 92 }));
    expect(repo.get('pod-1')?.score).toBe(92);
  });

  it('filters by runtime and model', () => {
    repo.insert(baseScore({ podId: 'a', runtime: 'claude', model: 'claude-opus-4-7' }));
    repo.insert(baseScore({ podId: 'b', runtime: 'claude', model: 'claude-sonnet-4-6' }));
    repo.insert(baseScore({ podId: 'c', runtime: 'codex', model: 'o1' }));

    const claude = repo.list({ runtime: 'claude' });
    expect(claude.map((r) => r.podId).sort()).toEqual(['a', 'b']);

    const opus = repo.list({ model: 'claude-opus-4-7' });
    expect(opus.map((r) => r.podId)).toEqual(['a']);
  });

  it('filters by profile and since timestamp', () => {
    repo.insert(
      baseScore({
        podId: 'old',
        profileName: 'p1',
        computedAt: '2026-04-01T00:00:00.000Z',
      }),
    );
    repo.insert(
      baseScore({
        podId: 'new',
        profileName: 'p1',
        computedAt: '2026-04-20T00:00:00.000Z',
      }),
    );
    repo.insert(baseScore({ podId: 'other', profileName: 'p2' }));

    const recentP1 = repo.list({ profileName: 'p1', since: '2026-04-10T00:00:00.000Z' });
    expect(recentP1.map((r) => r.podId)).toEqual(['new']);
  });
});

describe('QualityScoreRepository.getQualityAnalytics', () => {
  // biome-ignore lint/suspicious/noExplicitAny: sqlite db
  let db: any;
  let repo: QualityScoreRepository;

  beforeEach(() => {
    db = createTestDb();
    db.pragma('foreign_keys = OFF');
    repo = createQualityScoreRepository(db);
  });

  it('empty fleet returns zero counts, all-zero distribution, sparkline length = days, flat delta', () => {
    const result = repo.getQualityAnalytics(30);
    expect(result.summary.totalPodsScored).toBe(0);
    expect(result.summary.avgScore).toBe(0);
    expect(result.summary.redCount).toBe(0);
    expect(result.summary.yellowCount).toBe(0);
    expect(result.summary.greenCount).toBe(0);
    expect(result.summary.deltaVsPrior.direction).toBe('flat');
    expect(result.sparkline).toHaveLength(30);
    expect(result.distribution).toHaveLength(10);
    expect(result.distribution.every((b) => b.count === 0)).toBe(true);
    expect(Object.values(result.reasons).every((v) => v === 0)).toBe(true);
    expect(result.scores).toHaveLength(0);
  });

  it('single pod score 85 — greenCount=1, correct histogram bucket', () => {
    repo.insert(baseScore({ podId: 'p1', score: 85 }));
    const result = repo.getQualityAnalytics(30);
    expect(result.summary.totalPodsScored).toBe(1);
    expect(result.summary.greenCount).toBe(1);
    expect(result.summary.redCount).toBe(0);
    expect(result.summary.yellowCount).toBe(0);
    // bucket index 8 = "80-89"
    expect(result.distribution[8]).toEqual({ bucket: '80-89', count: 1 });
    // all other buckets zero
    expect(result.distribution.filter((_, i) => i !== 8).every((b) => b.count === 0)).toBe(true);
  });

  it('score 100 lands in bucket 90-100, not a phantom 11th bucket', () => {
    repo.insert(baseScore({ podId: 'p1', score: 100 }));
    const result = repo.getQualityAnalytics(30);
    expect(result.distribution).toHaveLength(10);
    expect(result.distribution[9]).toEqual({ bucket: '90-100', count: 1 });
  });

  it('window boundary — pod at exact edge is included, pod one second before is excluded', () => {
    const edgeAt = (db.prepare(`SELECT datetime('now', '-7 days') AS t`).get() as { t: string }).t;
    const justBefore = (
      db.prepare(`SELECT datetime(?, '-1 second') AS t`).get(edgeAt) as { t: string }
    ).t;
    repo.insert(baseScore({ podId: 'at-edge', completedAt: edgeAt }));
    repo.insert(baseScore({ podId: 'before-edge', completedAt: justBefore }));
    const result = repo.getQualityAnalytics(7);
    const ids = result.scores.map((s) => s.podId);
    expect(ids).toContain('at-edge');
    expect(ids).not.toContain('before-edge');
  });

  it('reason counters de-duplicate — pod with multiple signals contributes 1 per reason', () => {
    repo.insert(
      baseScore({
        podId: 'multi',
        editsWithoutPriorRead: 5,
        userInterrupts: 2,
      }),
    );
    const result = repo.getQualityAnalytics(30);
    expect(result.reasons.editsWithoutPriorRead).toBe(1);
    expect(result.reasons.userInterrupts).toBe(1);
  });

  it('all seven reason signals are counted correctly', () => {
    repo.insert(
      baseScore({
        podId: 'all-signals',
        readEditRatio: 0.5,
        editCount: 2,
        editsWithoutPriorRead: 1,
        userInterrupts: 1,
        validationPassed: false,
        prFixAttempts: 1,
        editChurnCount: 1,
        tellsCount: 1,
      }),
    );
    const result = repo.getQualityAnalytics(30);
    expect(result.reasons.lowReadEditRatio).toBe(1);
    expect(result.reasons.editsWithoutPriorRead).toBe(1);
    expect(result.reasons.userInterrupts).toBe(1);
    expect(result.reasons.validationFailed).toBe(1);
    expect(result.reasons.prFixAttempts).toBe(1);
    expect(result.reasons.editChurn).toBe(1);
    expect(result.reasons.tells).toBe(1);
  });

  it('deltaVsPrior — direction and value match avg-score difference', () => {
    // Prior window: 30-60 days ago, avg score 60
    const priorAt = (db.prepare(`SELECT datetime('now', '-45 days') AS t`).get() as { t: string })
      .t;
    repo.insert(baseScore({ podId: 'prior', score: 60, completedAt: priorAt }));
    // Current window: last 30 days, avg score 80
    repo.insert(baseScore({ podId: 'current', score: 80 }));
    const result = repo.getQualityAnalytics(30);
    expect(result.summary.deltaVsPrior.direction).toBe('up');
    expect(result.summary.deltaVsPrior.value).toBeCloseTo(20, 5);
  });

  it('deltaVsPrior is flat when prior window has zero pods', () => {
    repo.insert(baseScore({ podId: 'p1', score: 75 }));
    const result = repo.getQualityAnalytics(30);
    expect(result.summary.deltaVsPrior.direction).toBe('flat');
    expect(result.summary.deltaVsPrior.value).toBe(0);
  });

  it('pod with final_status killed is included', () => {
    repo.insert(baseScore({ podId: 'k1', finalStatus: 'killed' }));
    const result = repo.getQualityAnalytics(30);
    expect(result.summary.totalPodsScored).toBe(1);
    expect(result.scores[0]?.podId).toBe('k1');
  });

  it('redCount + yellowCount + greenCount === totalPodsScored', () => {
    repo.insert(baseScore({ podId: 'r', score: 40 })); // red
    repo.insert(baseScore({ podId: 'y', score: 70 })); // yellow
    repo.insert(baseScore({ podId: 'g', score: 90 })); // green
    const { summary } = repo.getQualityAnalytics(30);
    expect(summary.redCount + summary.yellowCount + summary.greenCount).toBe(
      summary.totalPodsScored,
    );
    expect(summary.redCount).toBe(1);
    expect(summary.yellowCount).toBe(1);
    expect(summary.greenCount).toBe(1);
  });

  it('sparkline length always equals days even when no pods scored', () => {
    expect(repo.getQualityAnalytics(7).sparkline).toHaveLength(7);
    expect(repo.getQualityAnalytics(90).sparkline).toHaveLength(90);
  });
});
