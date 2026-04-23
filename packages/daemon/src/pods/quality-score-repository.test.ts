import type { PodQualityScore } from '@autopod/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { createTestDb } from '../test-utils/mock-helpers.js';
import {
  type QualityScoreRepository,
  createQualityScoreRepository,
} from './quality-score-repository.js';

function baseScore(overrides: Partial<PodQualityScore> = {}): PodQualityScore {
  return {
    podId: 'pod-1',
    score: 85,
    readCount: 10,
    editCount: 2,
    readEditRatio: 5,
    editsWithoutPriorRead: 0,
    userInterrupts: 0,
    tellsCount: 0,
    inputTokens: 1000,
    outputTokens: 500,
    costUsd: 0.12,
    runtime: 'claude',
    profileName: 'test-profile',
    model: 'claude-opus-4-7',
    finalStatus: 'complete',
    completedAt: '2026-04-23T12:00:00.000Z',
    computedAt: '2026-04-23T12:00:01.000Z',
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
