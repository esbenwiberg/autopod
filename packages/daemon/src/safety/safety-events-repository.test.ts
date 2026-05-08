import { beforeEach, describe, expect, it } from 'vitest';
import { createTestDb } from '../test-utils/mock-helpers.js';
import { createSafetyEventsRepository } from './safety-events-repository.js';

describe('SafetyEventsRepository', () => {
  let db: ReturnType<typeof createTestDb>;
  let repo: ReturnType<typeof createSafetyEventsRepository>;

  beforeEach(() => {
    db = createTestDb();
    repo = createSafetyEventsRepository(db);
  });

  // ── insert + read round-trip ─────────────────────────────────────────────

  it('insert + countByKindInWindow round-trip (PII + injection)', () => {
    repo.insert({
      podId: 'pod-1',
      source: 'action_response',
      kind: 'pii',
      patternName: 'email',
      severity: null,
      payloadExcerpt: 'sanitized text',
    });
    repo.insert({
      podId: 'pod-1',
      source: 'action_response',
      kind: 'injection',
      patternName: 'direct-instruction',
      severity: 0.8,
      payloadExcerpt: 'blocked text',
    });

    const counts = repo.countByKindInWindow(30);
    expect(counts.pii).toBe(1);
    expect(counts.injection).toBe(1);
  });

  // ── trailing-window cutoff ───────────────────────────────────────────────

  it('trailing-window cutoff: only includes rows within the window', () => {
    // Insert recent row (5 days ago)
    db.prepare(
      `INSERT INTO safety_events (pod_id, source, kind, pattern_name, severity, created_at)
       VALUES ('pod-a', 'action_response', 'pii', 'api-key', NULL,
               datetime('now', '-5 days'))`,
    ).run();

    // Insert old row (35 days ago — outside a 30-day window)
    db.prepare(
      `INSERT INTO safety_events (pod_id, source, kind, pattern_name, severity, created_at)
       VALUES ('pod-a', 'action_response', 'pii', 'email', NULL,
               datetime('now', '-35 days'))`,
    ).run();

    const counts = repo.countByKindInWindow(30);
    expect(counts.pii).toBe(1); // only the recent row
  });

  // ── attachPodId ──────────────────────────────────────────────────────────

  it('attachPodId backfills pod_id on NULL rows', () => {
    const rowId = repo.insert({
      podId: null,
      source: 'issue_body',
      kind: 'injection',
      patternName: 'role-manipulation',
      severity: 0.7,
      payloadExcerpt: null,
    });

    repo.attachPodId([rowId], 'abc12345');

    const byPod = repo.countByPodInWindow(30, 10);
    expect(byPod).toHaveLength(1);
    expect(byPod[0]?.podId).toBe('abc12345');
    expect(byPod[0]?.eventCount).toBe(1);
  });

  it('attachPodId with empty rowIds is a no-op', () => {
    expect(() => repo.attachPodId([], 'any')).not.toThrow();
  });

  // ── countByPatternInWindow ───────────────────────────────────────────────

  it('countByPatternInWindow groups by pattern correctly', () => {
    // Three injections: two distinct patterns
    repo.insert({
      podId: 'pod-1',
      source: 'mcp_proxy',
      kind: 'injection',
      patternName: 'direct-instruction',
      severity: 0.8,
      payloadExcerpt: null,
    });
    repo.insert({
      podId: 'pod-1',
      source: 'mcp_proxy',
      kind: 'injection',
      patternName: 'direct-instruction',
      severity: 0.8,
      payloadExcerpt: null,
    });
    repo.insert({
      podId: 'pod-1',
      source: 'mcp_proxy',
      kind: 'injection',
      patternName: 'role-manipulation',
      severity: 0.7,
      payloadExcerpt: null,
    });

    const result = repo.countByPatternInWindow(30);
    expect(result).toHaveLength(2);

    const direct = result.find((r) => r.patternName === 'direct-instruction');
    const role = result.find((r) => r.patternName === 'role-manipulation');
    expect(direct?.count).toBe(2);
    expect(role?.count).toBe(1);
    // Both are injection kind
    expect(direct?.kind).toBe('injection');
    expect(role?.kind).toBe('injection');
  });

  // ── countByPodInWindow ordering + NULL grouping ──────────────────────────

  it('countByPodInWindow: ordered by lastEventAt DESC with limit', () => {
    db.prepare(
      `INSERT INTO safety_events (pod_id, source, kind, pattern_name, severity, created_at)
       VALUES ('pod-old', 'action_response', 'pii', 'email', NULL, datetime('now', '-10 days'))`,
    ).run();
    db.prepare(
      `INSERT INTO safety_events (pod_id, source, kind, pattern_name, severity, created_at)
       VALUES ('pod-new', 'action_response', 'pii', 'email', NULL, datetime('now', '-1 day'))`,
    ).run();
    db.prepare(
      `INSERT INTO safety_events (pod_id, source, kind, pattern_name, severity, created_at)
       VALUES ('pod-mid', 'action_response', 'pii', 'email', NULL, datetime('now', '-5 days'))`,
    ).run();

    const result = repo.countByPodInWindow(30, 10);
    expect(result[0]?.podId).toBe('pod-new');
    expect(result[1]?.podId).toBe('pod-mid');
    expect(result[2]?.podId).toBe('pod-old');
  });

  it('countByPodInWindow: respects limit', () => {
    for (let i = 0; i < 5; i++) {
      repo.insert({
        podId: `pod-${i}`,
        source: 'action_response',
        kind: 'pii',
        patternName: 'email',
        severity: null,
        payloadExcerpt: null,
      });
    }
    const result = repo.countByPodInWindow(30, 3);
    expect(result).toHaveLength(3);
  });

  it('countByPodInWindow: NULL pod_id rows returned with podId: null', () => {
    repo.insert({
      podId: null,
      source: 'pod_input',
      kind: 'injection',
      patternName: 'tool-abuse',
      severity: 0.5,
      payloadExcerpt: null,
    });

    const result = repo.countByPodInWindow(30, 10);
    expect(result).toHaveLength(1);
    // Brief 05 aggregator maps null → __pre_creation__; repo returns raw null
    expect(result[0]?.podId).toBeNull();
    expect(result[0]?.eventCount).toBe(1);
  });

  // ── topInjectionsForPod ──────────────────────────────────────────────────

  it('topInjectionsForPod returns injection rows for a specific pod', () => {
    repo.insert({
      podId: 'pod-x',
      source: 'action_response',
      kind: 'injection',
      patternName: 'direct-instruction',
      severity: 0.8,
      payloadExcerpt: 'blocked content',
    });
    // PII row should NOT appear in topInjections
    repo.insert({
      podId: 'pod-x',
      source: 'action_response',
      kind: 'pii',
      patternName: 'email',
      severity: null,
      payloadExcerpt: 'sanitized',
    });

    const result = repo.topInjectionsForPod('pod-x', 5);
    expect(result).toHaveLength(1);
    expect(result[0]?.patternName).toBe('direct-instruction');
    expect(result[0]?.severity).toBe(0.8);
  });

  it('topInjectionsForPod with null podId returns pre-creation rows', () => {
    repo.insert({
      podId: null,
      source: 'pod_input',
      kind: 'injection',
      patternName: 'tool-abuse',
      severity: 0.5,
      payloadExcerpt: 'test',
    });

    const result = repo.topInjectionsForPod(null, 5);
    expect(result).toHaveLength(1);
    expect(result[0]?.patternName).toBe('tool-abuse');
  });

  // ── sparkline ────────────────────────────────────────────────────────────

  it('sparkline returns exactly `days` entries', () => {
    const result = repo.sparkline(7);
    expect(result).toHaveLength(7);
    // All counts should be 0 (nothing inserted)
    for (const entry of result) {
      expect(entry.count).toBe(0);
    }
  });

  it('sparkline returns exactly `days` entries even with data', () => {
    repo.insert({
      podId: 'pod-1',
      source: 'action_response',
      kind: 'pii',
      patternName: 'email',
      severity: null,
      payloadExcerpt: null,
    });

    const result = repo.sparkline(30);
    expect(result).toHaveLength(30);

    // Days should be in ascending order
    for (let i = 1; i < result.length; i++) {
      const cur = result[i];
      const prev = result[i - 1];
      if (!cur || !prev) throw new Error('sparkline entry missing');
      expect(cur.day >= prev.day).toBe(true);
    }

    // Total count across sparkline should be 1
    const total = result.reduce((sum, e) => sum + e.count, 0);
    expect(total).toBe(1);
  });

  it('sparkline: zero-day entries are included', () => {
    // Insert one row 3 days ago
    db.prepare(
      `INSERT INTO safety_events (pod_id, source, kind, pattern_name, severity, created_at)
       VALUES ('pod-1', 'action_response', 'pii', 'email', NULL, datetime('now', '-3 days'))`,
    ).run();

    const result = repo.sparkline(7);
    expect(result).toHaveLength(7);
    // Most days should be 0; at least one should be non-zero
    const nonZero = result.filter((e) => e.count > 0);
    expect(nonZero).toHaveLength(1);
    expect(nonZero[0]?.count).toBe(1);
  });
});
