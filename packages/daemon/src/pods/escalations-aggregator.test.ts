import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestDb,
  insertTestProfile,
  insertTestScheduledJob,
} from '../test-utils/mock-helpers.js';
import { computeEscalationsAnalytics } from './escalations-aggregator.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

let seq = 0;

interface InsertPodOpts {
  id?: string;
  status?: string;
  completedAt?: string | null;
  createdAt?: string;
  outputMode?: string;
  profileName?: string;
  scheduledJobId?: string | null;
}

function insertPod(db: Database.Database, opts: InsertPodOpts = {}): string {
  const id = opts.id ?? `pod-${++seq}`;
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO pods (
      id, profile_name, task, status, model, runtime, execution_target, branch,
      user_id, max_validation_attempts, skip_validation,
      output_mode, agent_mode, output_target, validate, promotable,
      created_at, started_at, completed_at, rework_count, scheduled_job_id
    ) VALUES (
      @id, @profileName, 'task', @status, 'claude-opus-4-7', 'claude', 'local', 'branch-1',
      'user-1', 3, 0,
      @outputMode, 'auto', 'pr', 1, 0,
      @createdAt, @createdAt, @completedAt, 0, @scheduledJobId
    )
  `).run({
    id,
    profileName: opts.profileName ?? 'test-profile',
    status: opts.status ?? 'complete',
    outputMode: opts.outputMode ?? 'pr',
    createdAt: opts.createdAt ?? now,
    completedAt: opts.completedAt !== undefined ? opts.completedAt : now,
    scheduledJobId: opts.scheduledJobId ?? null,
  });
  return id;
}

interface InsertEscalationOpts {
  id?: string;
  podId: string;
  type: string;
  payload?: Record<string, unknown>;
  createdAt?: string;
  resolvedAt?: string | null;
}

function insertEscalation(db: Database.Database, opts: InsertEscalationOpts): string {
  const id = opts.id ?? `esc-${++seq}`;
  db.prepare(`
    INSERT INTO escalations (id, pod_id, type, payload, created_at, resolved_at)
    VALUES (@id, @podId, @type, @payload, @createdAt, @resolvedAt)
  `).run({
    id,
    podId: opts.podId,
    type: opts.type,
    payload: JSON.stringify(opts.payload ?? {}),
    createdAt: opts.createdAt ?? new Date().toISOString(),
    resolvedAt: opts.resolvedAt !== undefined ? opts.resolvedAt : null,
  });
  return id;
}

/** days ago as ISO string */
function daysAgo(n: number): string {
  return new Date(Date.now() - n * 86_400_000).toISOString();
}

/** seconds ago as ISO string */
function secondsAgo(n: number): string {
  return new Date(Date.now() - n * 1000).toISOString();
}

/** exact ISO string N seconds after a base */
function secondsAfter(base: string, n: number): string {
  return new Date(new Date(base).getTime() + n * 1000).toISOString();
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('computeEscalationsAnalytics', () => {
  let db: Database.Database;

  beforeEach(() => {
    seq = 0;
    db = createTestDb();
    insertTestProfile(db);
  });

  afterEach(() => {
    db.close();
  });

  // ── Empty cohort ────────────────────────────────────────────────────────────

  it('empty cohort returns default response', () => {
    const result = computeEscalationsAnalytics(db, 30);

    expect(result.summary.selfRecoveryRate).toBe(1.0);
    expect(result.summary.cohortSize).toBe(0);
    expect(result.summary.humanAttentionPodCount).toBe(0);
    expect(result.summary.humanAttentionCount).toBe(0);
    expect(result.summary.askAiCount).toBe(0);
    expect(result.summary.dailyHumanCountSparkline).toHaveLength(30);
    expect(result.summary.dailyHumanCountSparkline.every((d) => d.count === 0)).toBe(true);
    expect(result.summary.selfRecoveryRateDelta).toEqual({ value: 0, direction: 'flat' });
    expect(result.askHumanTtr.buckets).toHaveLength(8);
    expect(result.askHumanTtr.buckets.every((b) => b.count === 0)).toBe(true);
    expect(result.askHumanTtr.resolvedCount).toBe(0);
    expect(result.askHumanTtr.openCount).toBe(0);
    expect(result.askHumanTtr.maxSeconds).toBe(0);
    expect(result.perProfile).toEqual([]);
    expect(result.blockerPatterns).toEqual([]);
  });

  // ── Self-recovery math ──────────────────────────────────────────────────────

  it('self-recovery math: 10 pods, 3 escalated => rate 0.7', () => {
    for (let i = 0; i < 10; i++) {
      insertPod(db, { id: `pod-sr-${i}` });
    }
    // 3 pods get human-attention escalations
    for (let i = 0; i < 3; i++) {
      insertEscalation(db, { podId: `pod-sr-${i}`, type: 'ask_human' });
    }

    const result = computeEscalationsAnalytics(db, 30);
    expect(result.summary.selfRecoveryRate).toBeCloseTo(0.7);
    expect(result.summary.cohortSize).toBe(10);
    expect(result.summary.humanAttentionPodCount).toBe(3);
  });

  // ── Multi-escalation pod ────────────────────────────────────────────────────

  it('multi-escalation pod: humanAttentionPodCount is distinct, humanAttentionCount is total rows', () => {
    const podId = insertPod(db);
    insertEscalation(db, { podId, type: 'ask_human' });
    insertEscalation(db, { podId, type: 'ask_human' });
    insertEscalation(db, { podId, type: 'ask_human' });

    const result = computeEscalationsAnalytics(db, 30);
    expect(result.summary.humanAttentionPodCount).toBe(1);
    expect(result.summary.humanAttentionCount).toBe(3);
  });

  // ── ask_ai exclusion from rate ──────────────────────────────────────────────

  it('ask_ai escalations do not affect self-recovery rate', () => {
    for (let i = 0; i < 5; i++) {
      const podId = insertPod(db, { id: `pod-ai-${i}` });
      insertEscalation(db, { podId, type: 'ask_ai' });
    }

    const result = computeEscalationsAnalytics(db, 30);
    expect(result.summary.selfRecoveryRate).toBe(1.0);
    expect(result.summary.askAiCount).toBeGreaterThan(0);
    expect(result.summary.humanAttentionPodCount).toBe(0);
  });

  // ── request_credential exclusion ────────────────────────────────────────────

  it('request_credential does not appear in humanAttentionCount or askAiCount', () => {
    const podId = insertPod(db);
    insertEscalation(db, { podId, type: 'request_credential' });

    const result = computeEscalationsAnalytics(db, 30);
    expect(result.summary.humanAttentionCount).toBe(0);
    expect(result.summary.askAiCount).toBe(0);
    expect(result.summary.humanAttentionPodCount).toBe(0);
  });

  // ── Trailing-window bucketing ───────────────────────────────────────────────

  it('escalations outside window do not appear in window-scoped sections', () => {
    const podId = insertPod(db);
    // Inside window
    insertEscalation(db, { podId, type: 'ask_human', createdAt: daysAgo(5) });
    // Outside window (31 days ago for 30-day window)
    insertEscalation(db, { podId, type: 'ask_human', createdAt: daysAgo(31) });
    // Outside window blocker pattern
    insertEscalation(db, {
      podId,
      type: 'report_blocker',
      payload: { description: 'Old blocker' },
      createdAt: daysAgo(31),
    });

    const result = computeEscalationsAnalytics(db, 30);
    // askHumanTtr: only the inside-window row counts (it has no resolved_at so openCount = 1)
    expect(result.askHumanTtr.openCount).toBe(1);
    // blockerPatterns: outside-window row excluded
    expect(result.blockerPatterns).toHaveLength(0);
  });

  // ── TTR bucket boundaries ───────────────────────────────────────────────────

  it('TTR bucket boundaries are right-exclusive', () => {
    const podId = insertPod(db);

    // <1m bucket: 1s
    const t1 = secondsAgo(3600);
    insertEscalation(db, {
      podId,
      type: 'ask_human',
      createdAt: t1,
      resolvedAt: secondsAfter(t1, 1),
    });
    // <1m boundary: 59s lands in <1m
    const t59 = secondsAgo(7200);
    insertEscalation(db, {
      podId,
      type: 'ask_human',
      createdAt: t59,
      resolvedAt: secondsAfter(t59, 59),
    });
    // 1–5m bucket: exactly 60s (right-exclusive: 60s NOT in <1m)
    const t60 = secondsAgo(10800);
    insertEscalation(db, {
      podId,
      type: 'ask_human',
      createdAt: t60,
      resolvedAt: secondsAfter(t60, 60),
    });
    // 1–5m bucket: 300s is NOT in 1–5m (right-exclusive → lands in 5–15m)
    const t300 = secondsAgo(14400);
    insertEscalation(db, {
      podId,
      type: 'ask_human',
      createdAt: t300,
      resolvedAt: secondsAfter(t300, 300),
    });
    // >24h: 100000s
    const t100k = secondsAgo(200000);
    insertEscalation(db, {
      podId,
      type: 'ask_human',
      createdAt: t100k,
      resolvedAt: secondsAfter(t100k, 100000),
    });

    const result = computeEscalationsAnalytics(db, 30);
    const buckets = result.askHumanTtr.buckets;
    expect(buckets[0]!.label).toBe('<1m');
    expect(buckets[0]!.count).toBe(2); // 1s and 59s
    expect(buckets[1]!.label).toBe('1–5m');
    expect(buckets[1]!.count).toBe(1); // 60s
    expect(buckets[2]!.label).toBe('5–15m');
    expect(buckets[2]!.count).toBe(1); // 300s
    expect(buckets[7]!.label).toBe('>24h');
    expect(buckets[7]!.count).toBe(1); // 100000s
  });

  // ── TTR open exclusion ──────────────────────────────────────────────────────

  it('open ask_human rows contribute to openCount only, not histogram', () => {
    const podId = insertPod(db);
    const tResolved = secondsAgo(3600);
    // Resolved: goes to buckets
    insertEscalation(db, {
      podId,
      type: 'ask_human',
      createdAt: tResolved,
      resolvedAt: secondsAfter(tResolved, 120),
    });
    // Open: goes to openCount only
    insertEscalation(db, { podId, type: 'ask_human', resolvedAt: null });

    const result = computeEscalationsAnalytics(db, 30);
    expect(result.askHumanTtr.resolvedCount).toBe(1);
    expect(result.askHumanTtr.openCount).toBe(1);
    const totalBucketCount = result.askHumanTtr.buckets.reduce((s, b) => s + b.count, 0);
    expect(totalBucketCount).toBe(1);
  });

  // ── TTR max ─────────────────────────────────────────────────────────────────

  it('maxSeconds is the largest TTR in the resolved cohort', () => {
    const podId = insertPod(db);
    const t1 = secondsAgo(7200);
    insertEscalation(db, {
      podId,
      type: 'ask_human',
      createdAt: t1,
      resolvedAt: secondsAfter(t1, 30),
    });
    const t2 = secondsAgo(14400);
    insertEscalation(db, {
      podId,
      type: 'ask_human',
      createdAt: t2,
      resolvedAt: secondsAfter(t2, 7200),
    });

    const result = computeEscalationsAnalytics(db, 30);
    expect(result.askHumanTtr.maxSeconds).toBeCloseTo(7200, 0);
  });

  // ── Per-profile sort + fold-in ──────────────────────────────────────────────

  it('per-profile: fold-in <5 pod profiles and sort by rate DESC, ties by podCount DESC', () => {
    // Profile A: 10 pods, 5 escalated → rate 0.5
    insertTestProfile(db, { name: 'A' });
    for (let i = 0; i < 10; i++) {
      const podId = insertPod(db, { id: `a-${i}`, profileName: 'A' });
      if (i < 5) insertEscalation(db, { podId, type: 'ask_human' });
    }

    // Profile B: 8 pods, 2 escalated → rate 0.25
    insertTestProfile(db, { name: 'B' });
    for (let i = 0; i < 8; i++) {
      const podId = insertPod(db, { id: `b-${i}`, profileName: 'B' });
      if (i < 2) insertEscalation(db, { podId, type: 'ask_human' });
    }

    // Profile C: 3 pods (< 5), 3 escalated → rate 1.0, folds in
    insertTestProfile(db, { name: 'C' });
    for (let i = 0; i < 3; i++) {
      const podId = insertPod(db, { id: `c-${i}`, profileName: 'C' });
      insertEscalation(db, { podId, type: 'ask_human' });
    }

    // Profile D: 2 pods (< 5), 0 escalated → rate 0.0, folds in
    insertTestProfile(db, { name: 'D' });
    for (let i = 0; i < 2; i++) {
      insertPod(db, { id: `d-${i}`, profileName: 'D' });
    }

    const result = computeEscalationsAnalytics(db, 30);
    const rows = result.perProfile;

    // Expect 3 rows: <small profiles>, A, B (test-profile has 0 pods so absent)
    const smallRow = rows.find((r) => r.profile === '<small profiles>');
    expect(smallRow).toBeDefined();
    expect(smallRow!.podCount).toBe(5); // C(3) + D(2)
    expect(smallRow!.escalatedCount).toBe(3); // C(3) + D(0)
    expect(smallRow!.rate).toBeCloseTo(0.6);

    // Sorted by rate DESC: small(0.6), A(0.5), B(0.25)
    const profilesWithData = rows.filter((r) => ['<small profiles>', 'A', 'B'].includes(r.profile));
    expect(profilesWithData[0]!.profile).toBe('<small profiles>');
    expect(profilesWithData[1]!.profile).toBe('A');
    expect(profilesWithData[2]!.profile).toBe('B');
  });

  it('tie-break: same rate, higher podCount first', () => {
    insertTestProfile(db, { name: 'X' });
    insertTestProfile(db, { name: 'Y' });

    // Profile X: 10 pods, 5 escalated → rate 0.5
    for (let i = 0; i < 10; i++) {
      const podId = insertPod(db, { id: `x-${i}`, profileName: 'X' });
      if (i < 5) insertEscalation(db, { podId, type: 'ask_human' });
    }
    // Profile Y: 8 pods, 4 escalated → rate 0.5
    for (let i = 0; i < 8; i++) {
      const podId = insertPod(db, { id: `y-${i}`, profileName: 'Y' });
      if (i < 4) insertEscalation(db, { podId, type: 'ask_human' });
    }

    const result = computeEscalationsAnalytics(db, 30);
    const profiles = result.perProfile.filter((r) => ['X', 'Y'].includes(r.profile));
    expect(profiles[0]!.profile).toBe('X'); // higher podCount wins
    expect(profiles[1]!.profile).toBe('Y');
  });

  it('per-profile fold-in suppressed when all profiles have podCount >= 5', () => {
    insertTestProfile(db, { name: 'Big' });
    for (let i = 0; i < 6; i++) {
      insertPod(db, { id: `big-${i}`, profileName: 'Big' });
    }

    const result = computeEscalationsAnalytics(db, 30);
    expect(result.perProfile.every((r) => r.profile !== '<small profiles>')).toBe(true);
  });

  // ── Blocker pattern grouping ────────────────────────────────────────────────

  it('blocker pattern grouping: exact-string, case-sensitive, after trim', () => {
    const podId = insertPod(db);

    // "Cannot find file" × 3
    for (let i = 0; i < 3; i++) {
      insertEscalation(db, {
        podId,
        type: 'report_blocker',
        payload: { description: 'Cannot find file' },
      });
    }
    // "Cannot find file." × 2 (different by trailing dot)
    for (let i = 0; i < 2; i++) {
      insertEscalation(db, {
        podId,
        type: 'report_blocker',
        payload: { description: 'Cannot find file.' },
      });
    }
    // " Cannot find file " × 1 — trims to match group 1
    insertEscalation(db, {
      podId,
      type: 'report_blocker',
      payload: { description: ' Cannot find file ' },
    });
    // Empty description — skipped
    insertEscalation(db, {
      podId,
      type: 'report_blocker',
      payload: { description: '' },
    });
    // No description field — skipped
    insertEscalation(db, {
      podId,
      type: 'report_blocker',
      payload: {},
    });

    const result = computeEscalationsAnalytics(db, 30);
    expect(result.blockerPatterns).toHaveLength(2);
    expect(result.blockerPatterns[0]!.description).toBe('Cannot find file');
    expect(result.blockerPatterns[0]!.count).toBe(4); // 3 + 1 trimmed
    expect(result.blockerPatterns[1]!.description).toBe('Cannot find file.');
    expect(result.blockerPatterns[1]!.count).toBe(2);
  });

  // ── Blocker pattern pod-id cap ──────────────────────────────────────────────

  it('blocker pattern pod-ids capped at 10, count reflects true total', () => {
    const description = 'Disk full';
    for (let i = 0; i < 15; i++) {
      insertTestProfile(db, { name: `prof-${i}` });
      const podId = insertPod(db, { id: `cap-pod-${i}`, profileName: `prof-${i}` });
      insertEscalation(db, {
        podId,
        type: 'report_blocker',
        payload: { description },
        createdAt: daysAgo(i), // different timestamps so ordering is deterministic
      });
    }

    const result = computeEscalationsAnalytics(db, 30);
    expect(result.blockerPatterns).toHaveLength(1);
    expect(result.blockerPatterns[0]!.count).toBe(15);
    expect(result.blockerPatterns[0]!.podIds).toHaveLength(10);
  });

  // ── Blocker pattern not cohort-restricted ───────────────────────────────────

  it('blocker patterns appear even for workspace pods excluded from terminal cohort', () => {
    const podId = insertPod(db, { outputMode: 'workspace' });
    insertEscalation(db, {
      podId,
      type: 'report_blocker',
      payload: { description: 'Workspace blocker' },
    });

    const result = computeEscalationsAnalytics(db, 30);
    expect(result.blockerPatterns).toHaveLength(1);
    expect(result.blockerPatterns[0]!.description).toBe('Workspace blocker');
  });

  it('blocker patterns exclude scheduled-job pods by default', () => {
    insertTestScheduledJob(db, { id: 'job-1' });
    const scheduledPodId = insertPod(db, { id: 'scheduled-pod', scheduledJobId: 'job-1' });
    const interactivePodId = insertPod(db, { id: 'interactive-pod' });
    insertEscalation(db, {
      podId: scheduledPodId,
      type: 'report_blocker',
      payload: { description: 'Scheduled findings digest' },
    });
    insertEscalation(db, {
      podId: interactivePodId,
      type: 'report_blocker',
      payload: { description: 'Real blocker' },
    });

    const result = computeEscalationsAnalytics(db, 30);

    expect(result.blockerPatterns).toHaveLength(1);
    expect(result.blockerPatterns[0]!.description).toBe('Real blocker');
  });

  it('scope can include only scheduled-job blocker patterns', () => {
    insertTestScheduledJob(db, { id: 'job-1' });
    const scheduledPodId = insertPod(db, { id: 'scheduled-pod', scheduledJobId: 'job-1' });
    const interactivePodId = insertPod(db, { id: 'interactive-pod' });
    insertEscalation(db, {
      podId: scheduledPodId,
      type: 'report_blocker',
      payload: { description: 'Scheduled findings digest' },
    });
    insertEscalation(db, {
      podId: interactivePodId,
      type: 'report_blocker',
      payload: { description: 'Real blocker' },
    });

    const result = computeEscalationsAnalytics(db, 30, { scope: 'scheduled' });

    expect(result.blockerPatterns).toHaveLength(1);
    expect(result.blockerPatterns[0]!.description).toBe('Scheduled findings digest');
  });

  // ── Sparkline not cohort-restricted ────────────────────────────────────────

  it('dailyHumanCountSparkline includes workspace-pod escalations; humanAttentionCount excludes them', () => {
    const workspacePod = insertPod(db, { outputMode: 'workspace' });
    insertEscalation(db, { podId: workspacePod, type: 'ask_human' });

    const result = computeEscalationsAnalytics(db, 30);
    // Workspace pod is not in terminal cohort
    expect(result.summary.cohortSize).toBe(0);
    expect(result.summary.humanAttentionCount).toBe(0);
    // But sparkline sees the escalation
    const totalSparkline = result.summary.dailyHumanCountSparkline.reduce((s, d) => s + d.count, 0);
    expect(totalSparkline).toBe(1);
  });

  // ── Workspace exclusion from terminal cohort ────────────────────────────────

  it('workspace pod excluded from cohort summary and perProfile', () => {
    const wsPod = insertPod(db, { outputMode: 'workspace' });
    insertEscalation(db, { podId: wsPod, type: 'ask_human' });

    const result = computeEscalationsAnalytics(db, 30);
    expect(result.summary.cohortSize).toBe(0);
    expect(result.summary.humanAttentionPodCount).toBe(0);
    expect(result.summary.humanAttentionCount).toBe(0);
    expect(result.perProfile).toHaveLength(0);
    // askHumanTtr still counts the workspace pod's escalation (no pod restriction)
    expect(result.askHumanTtr.openCount).toBe(1);
  });

  // ── Prior-window delta ──────────────────────────────────────────────────────

  it('prior-window delta: rate improves from 0.5 to 0.8 => direction up', () => {
    // Prior window (31–60 days ago): 10 pods, 5 escalated → rate 0.5
    for (let i = 0; i < 10; i++) {
      const podId = insertPod(db, {
        id: `prior-${i}`,
        completedAt: daysAgo(31 + i * 0.5),
        createdAt: daysAgo(35 + i * 0.5),
      });
      if (i < 5) {
        insertEscalation(db, {
          podId,
          type: 'ask_human',
          createdAt: daysAgo(31 + i * 0.5),
        });
      }
    }

    // Current window (0–30 days ago): 10 pods, 2 escalated → rate 0.8
    for (let i = 0; i < 10; i++) {
      const podId = insertPod(db, {
        id: `curr-${i}`,
        completedAt: daysAgo(i * 2),
        createdAt: daysAgo(i * 2 + 1),
      });
      if (i < 2) {
        insertEscalation(db, {
          podId,
          type: 'ask_human',
          createdAt: daysAgo(i * 2),
        });
      }
    }

    const result = computeEscalationsAnalytics(db, 30);
    expect(result.summary.selfRecoveryRateDelta.value).toBeCloseTo(0.3, 1);
    expect(result.summary.selfRecoveryRateDelta.direction).toBe('up');
  });

  it('prior-window delta does not inflate cohortSize for pods with multiple escalations', () => {
    // Prior window (31–60 days ago): 1 pod with 5 ask_human escalations.
    // A naive COUNT(*) over a LEFT JOIN would report cohortSize=5, escalated=1
    // → priorRate (5-1)/5 = 0.8 and a misleading delta. Correct behaviour:
    // cohortSize=1, escalated=1 → priorRate=0, current rate=1.0, delta=+1.0.
    const priorPodId = insertPod(db, {
      id: 'prior-multi',
      completedAt: daysAgo(40),
      createdAt: daysAgo(45),
    });
    for (let i = 0; i < 5; i++) {
      insertEscalation(db, {
        podId: priorPodId,
        type: 'ask_human',
        createdAt: daysAgo(40),
      });
    }

    // Current window: 1 clean pod (no escalations) → rate 1.0.
    insertPod(db, {
      id: 'curr-clean',
      completedAt: daysAgo(5),
      createdAt: daysAgo(6),
    });

    const result = computeEscalationsAnalytics(db, 30);
    expect(result.summary.selfRecoveryRateDelta.value).toBeCloseTo(1.0, 5);
    expect(result.summary.selfRecoveryRateDelta.direction).toBe('up');
  });

  it('prior-window delta is flat when prior cohort is empty', () => {
    // Only current window has pods
    insertPod(db, { completedAt: daysAgo(5) });

    const result = computeEscalationsAnalytics(db, 30);
    expect(result.summary.selfRecoveryRateDelta).toEqual({ value: 0, direction: 'flat' });
  });

  // ── Bucket labels in correct order ─────────────────────────────────────────

  it('askHumanTtr.buckets always has 8 entries in the fixed label order', () => {
    const result = computeEscalationsAnalytics(db, 30);
    const labels = result.askHumanTtr.buckets.map((b) => b.label);
    expect(labels).toEqual(['<1m', '1–5m', '5–15m', '15m–1h', '1–4h', '4–12h', '12–24h', '>24h']);
  });

  // ── Sparkline length matches days ──────────────────────────────────────────

  it('sparkline length equals the requested days', () => {
    const result = computeEscalationsAnalytics(db, 14);
    expect(result.summary.dailyHumanCountSparkline).toHaveLength(14);
  });

  // ── blockerPatterns capped at 10 ───────────────────────────────────────────

  it('blockerPatterns length is always <= 10', () => {
    const podId = insertPod(db);
    for (let i = 0; i < 15; i++) {
      insertEscalation(db, {
        podId,
        type: 'report_blocker',
        payload: { description: `Unique blocker #${i}` },
      });
    }

    const result = computeEscalationsAnalytics(db, 30);
    expect(result.blockerPatterns.length).toBeLessThanOrEqual(10);
  });

  // ── all human-attention types count toward humanAttentionCount ─────────────

  it('all human-attention types (ask_human, report_blocker, validation_override, action_approval) count', () => {
    const podId = insertPod(db);
    insertEscalation(db, { podId, type: 'ask_human' });
    insertEscalation(db, { podId, type: 'report_blocker', payload: { description: 'x' } });
    insertEscalation(db, { podId, type: 'validation_override' });
    insertEscalation(db, { podId, type: 'action_approval' });

    const result = computeEscalationsAnalytics(db, 30);
    expect(result.summary.humanAttentionCount).toBe(4);
    expect(result.summary.humanAttentionPodCount).toBe(1);
  });
});
