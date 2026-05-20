import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, insertTestProfile } from '../test-utils/mock-helpers.js';
import { computeReliabilityAnalytics } from './reliability-aggregator.js';

function need<T>(v: T | null | undefined, label = 'value'): T {
  if (v === null || v === undefined) throw new Error(`expected ${label} to be defined`);
  return v;
}

// ── Pod insertion helper ──────────────────────────────────────────────────────

interface InsertPodOpts {
  id?: string;
  profileName?: string;
  status?: string;
  completedAt?: string;
  reworkCount?: number;
  outputMode?: string;
}

let seq = 0;

function insertPod(db: Database.Database, opts: InsertPodOpts = {}): string {
  const id = opts.id ?? `pod-${++seq}`;
  db.prepare(`
    INSERT INTO pods (
      id, profile_name, task, status, model, runtime, execution_target, branch,
      user_id, max_validation_attempts, skip_validation,
      output_mode, agent_mode, output_target, validate, promotable,
      completed_at, rework_count
    ) VALUES (
      @id, @profileName, 'task', @status, 'claude-opus-4-7', 'claude', 'local', 'branch-1',
      'user-1', 3, 0,
      @outputMode, 'auto', 'pr', 1, 0,
      @completedAt, @reworkCount
    )
  `).run({
    id,
    profileName: opts.profileName ?? 'test-profile',
    status: opts.status ?? 'complete',
    outputMode: opts.outputMode ?? 'pr',
    completedAt: opts.completedAt ?? new Date().toISOString(),
    reworkCount: opts.reworkCount ?? 0,
  });
  return id;
}

function insertStatusEvent(
  db: Database.Database,
  podId: string,
  previousStatus: string,
  newStatus: string,
): void {
  db.prepare(`
    INSERT INTO events (pod_id, type, payload)
    VALUES (@podId, 'pod.status_changed', @payload)
  `).run({
    podId,
    payload: JSON.stringify({
      type: 'pod.status_changed',
      timestamp: new Date().toISOString(),
      podId,
      previousStatus,
      newStatus,
    }),
  });
}

function insertValidation(
  db: Database.Database,
  podId: string,
  result: Record<string, unknown>,
  attempt = 0,
): void {
  db.prepare(`
    INSERT INTO validations (id, pod_id, attempt, result)
    VALUES (@id, @podId, @attempt, @result)
  `).run({
    id: `val-${podId}-${attempt}`,
    podId,
    attempt,
    result: JSON.stringify(result),
  });
}

function makeValidationResult(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    podId: 'pod-x',
    attempt: 0,
    timestamp: new Date().toISOString(),
    smoke: {
      status: 'pass',
      build: { status: 'pass', output: '', duration: 100 },
      health: { status: 'pass', url: 'http://localhost/', responseCode: 200, duration: 50 },
      pages: [],
    },
    taskReview: null,
    overall: 'pass',
    duration: 200,
    ...overrides,
  };
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

const ALL_BANDS = [
  'queued',
  'provisioning',
  'running',
  'validating',
  'validated',
  'approved',
  'merging',
  'complete',
];

function insertAllBandEvents(db: Database.Database, podId: string): void {
  const transitions = [
    ['queued', 'provisioning'],
    ['provisioning', 'running'],
    ['running', 'validating'],
    ['validating', 'validated'],
    ['validated', 'approved'],
    ['approved', 'merging'],
    ['merging', 'complete'],
  ];
  // Insert a 'queued' event first so the band is counted
  insertStatusEvent(db, podId, '', 'queued');
  for (const [prev, next] of transitions) {
    insertStatusEvent(db, podId, need(prev), need(next));
  }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('computeReliabilityAnalytics', () => {
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

  it('empty cohort returns zero-value response', () => {
    const result = computeReliabilityAnalytics(db, 30);

    expect(result.firstPassRate).toBe(0);
    expect(result.firstPassRateSparkline).toHaveLength(30);
    expect(result.firstPassRateSparkline.every((d) => d.rate === 0)).toBe(true);
    expect(result.funnel.bands).toHaveLength(8);
    expect(result.funnel.bands.every((b) => b.count === 0)).toBe(true);
    expect(result.funnel.drops).toEqual([]);
    expect(result.stageFailures).toHaveLength(8);
    expect(result.stageFailures.every((s) => s.podsRan === 0)).toBe(true);
    expect(result.profileHeatmap).toEqual([]);
    expect(result.summary.topFailureStage).toBe('');
    expect(result.summary.totalPodsInWindow).toBe(0);
  });

  // ── First-pass single pod ───────────────────────────────────────────────────

  it('single complete pod with all bands: firstPassRate=1, no drops, all band counts=1', () => {
    const podId = insertPod(db, { status: 'complete', reworkCount: 0 });
    insertAllBandEvents(db, podId);

    const result = computeReliabilityAnalytics(db, 30);

    expect(result.firstPassRate).toBe(1);
    expect(result.funnel.drops).toEqual([]);
    expect(result.funnel.bands.every((b) => b.count === 1)).toBe(true);
    expect(result.summary.totalPodsInWindow).toBe(1);
    expect(result.summary.avgReworkCount).toBe(0);
  });

  // ── Reworked pod ────────────────────────────────────────────────────────────

  it('complete pod with reworkCount=2: firstPassRate=0, counted in bands', () => {
    const podId = insertPod(db, { status: 'complete', reworkCount: 2 });
    insertAllBandEvents(db, podId);

    const result = computeReliabilityAnalytics(db, 30);

    expect(result.firstPassRate).toBe(0);
    // Pod still counted in each band it reached
    expect(need(result.funnel.bands.find((b) => b.band === 'complete')).count).toBe(1);
    expect(result.summary.avgReworkCount).toBe(2);
  });

  // ── Killed at running ───────────────────────────────────────────────────────

  it('killed pod stopped at running: drop (running, killed)', () => {
    const podId = insertPod(db, { status: 'killed' });
    insertStatusEvent(db, podId, '', 'queued');
    insertStatusEvent(db, podId, 'queued', 'provisioning');
    insertStatusEvent(db, podId, 'provisioning', 'running');

    const result = computeReliabilityAnalytics(db, 30);

    expect(result.funnel.drops).toHaveLength(1);
    const drop = need(result.funnel.drops[0]);
    expect(drop.from).toBe('running');
    expect(drop.to).toBe('killed');
    expect(drop.count).toBe(1);
    expect(drop.topPods).toHaveLength(1);
    expect(need(drop.topPods[0]).podId).toBe(podId);
    expect(drop.overflow).toBe(0);
  });

  // ── Failed at validating ────────────────────────────────────────────────────

  it('failed pod reached validating: drop (validating, failed)', () => {
    const podId = insertPod(db, { status: 'failed' });
    insertStatusEvent(db, podId, '', 'queued');
    insertStatusEvent(db, podId, 'queued', 'provisioning');
    insertStatusEvent(db, podId, 'provisioning', 'running');
    insertStatusEvent(db, podId, 'running', 'validating');

    const result = computeReliabilityAnalytics(db, 30);

    expect(result.funnel.drops).toHaveLength(1);
    const drop = need(result.funnel.drops[0]);
    expect(drop.from).toBe('validating');
    expect(drop.to).toBe('failed');
  });

  // ── Stage failure on smoke ──────────────────────────────────────────────────

  it('smoke page failure: podsFailed>=1 for smoke, topFailureStage=smoke', () => {
    const podId = insertPod(db, { status: 'complete' });
    insertValidation(
      db,
      podId,
      makeValidationResult({
        smoke: {
          status: 'fail',
          build: { status: 'pass', output: '', duration: 100 },
          health: { status: 'pass', url: 'http://localhost/', responseCode: 200, duration: 50 },
          pages: [
            {
              path: '/',
              status: 'fail',
              screenshotPath: '',
              consoleErrors: [],
              assertions: [],
              loadTime: 100,
            },
          ],
        },
      }),
    );

    const result = computeReliabilityAnalytics(db, 30);

    const smokeEntry = need(result.stageFailures.find((s) => s.stage === 'smoke'));
    expect(smokeEntry.podsFailed).toBeGreaterThanOrEqual(1);
    expect(result.summary.topFailureStage).toBe('smoke');
  });

  // ── Multi-attempt accumulation (ever-failed semantics) ──────────────────────

  it('two validation attempts: ever-failed semantics — fails test even if attempt 1 passes', () => {
    const podId = insertPod(db, { status: 'complete' });

    // Attempt 0: test fails
    insertValidation(
      db,
      podId,
      makeValidationResult({
        test: { status: 'fail', duration: 100 },
      }),
      0,
    );

    // Attempt 1: everything passes
    insertValidation(
      db,
      podId,
      makeValidationResult({
        test: { status: 'pass', duration: 100 },
      }),
      1,
    );

    const result = computeReliabilityAnalytics(db, 30);

    const testEntry = need(result.stageFailures.find((s) => s.stage === 'test'));
    expect(testEntry.podsFailed).toBe(1);
    expect(testEntry.podsRan).toBe(1);
  });

  // ── Profile heatmap exclusion ───────────────────────────────────────────────

  it('profile that never ran sast: no sast entry in heatmap stages', () => {
    const podId = insertPod(db, { status: 'complete', profileName: 'test-profile' });
    // Validation with no sast field
    insertValidation(
      db,
      podId,
      makeValidationResult({
        test: { status: 'pass', duration: 100 },
        // no sast
      }),
    );

    const result = computeReliabilityAnalytics(db, 30);

    const profileEntry = need(result.profileHeatmap.find((p) => p.profile === 'test-profile'));
    expect(profileEntry).toBeDefined();
    expect(profileEntry.stages.some((s) => s.stage === 'sast')).toBe(false);
  });

  // ── Drop overflow ───────────────────────────────────────────────────────────

  it('12 pods with same drop: topPods.length=10, overflow=2, ordered by completedAt DESC', () => {
    // Use a recent base time so pods fall within the 30-day cohort window
    const baseTime = new Date(Date.now() - 5 * 86_400_000); // 5 days ago

    for (let i = 0; i < 12; i++) {
      const completedAt = new Date(baseTime.getTime() + i * 60_000).toISOString();
      const podId = insertPod(db, { status: 'failed', completedAt });
      insertStatusEvent(db, podId, '', 'queued');
      insertStatusEvent(db, podId, 'queued', 'provisioning');
      insertStatusEvent(db, podId, 'provisioning', 'running');
    }

    const result = computeReliabilityAnalytics(db, 30);

    const drop = need(result.funnel.drops.find((d) => d.from === 'running' && d.to === 'failed'));
    expect(drop.count).toBe(12);
    expect(drop.topPods).toHaveLength(10);
    expect(drop.overflow).toBe(2);

    // Verify ordering: DESC by completedAt (most recent first)
    for (let i = 0; i < drop.topPods.length - 1; i++) {
      expect(need(drop.topPods[i]).completedAt >= need(drop.topPods[i + 1]).completedAt).toBe(true);
    }
  });

  // ── Sparkline length ────────────────────────────────────────────────────────

  it.each([1, 7, 30])('sparkline length matches days=%i', (days) => {
    const result = computeReliabilityAnalytics(db, days);
    expect(result.firstPassRateSparkline).toHaveLength(days);
  });

  it('sparkline most recent day is last entry', () => {
    const podId = insertPod(db, { status: 'complete', reworkCount: 0 });
    insertAllBandEvents(db, podId);

    const result = computeReliabilityAnalytics(db, 7);
    const days = result.firstPassRateSparkline;

    // Days should be in ascending order
    for (let i = 0; i < days.length - 1; i++) {
      expect(need(days[i]).day < need(days[i + 1]).day).toBe(true);
    }
    // Last entry should be today (the sparkline window ends at today, inclusive)
    const today = new Date().toISOString().slice(0, 10);
    expect(need(days[days.length - 1]).day).toBe(today);
  });

  // ── Delta direction thresholds ──────────────────────────────────────────────

  it('delta direction: up when current >> prior (> +0.5pp)', () => {
    const now = new Date();
    // Current window: 100% first-pass
    insertPod(db, {
      status: 'complete',
      reworkCount: 0,
      completedAt: new Date(now.getTime() - 5 * 86_400_000).toISOString(),
    });
    // Prior window: 0% first-pass
    insertPod(db, {
      status: 'killed',
      completedAt: new Date(now.getTime() - 35 * 86_400_000).toISOString(),
    });

    const result = computeReliabilityAnalytics(db, 30);
    // delta = (1.0 - 0.0) * 100 = +100pp > +0.5pp → 'up'
    expect(result.firstPassRateDelta.direction).toBe('up');
    expect(result.firstPassRateDelta.value).toBeGreaterThan(0.5);
  });

  it('delta direction: down when current << prior (< -0.5pp)', () => {
    const now = new Date();
    // Current window: 0% first-pass
    insertPod(db, {
      status: 'failed',
      completedAt: new Date(now.getTime() - 5 * 86_400_000).toISOString(),
    });
    // Prior window: 100% first-pass
    insertPod(db, {
      status: 'complete',
      reworkCount: 0,
      completedAt: new Date(now.getTime() - 35 * 86_400_000).toISOString(),
    });

    const result = computeReliabilityAnalytics(db, 30);
    // delta = (0.0 - 1.0) * 100 = -100pp < -0.5pp → 'down'
    expect(result.firstPassRateDelta.direction).toBe('down');
    expect(result.firstPassRateDelta.value).toBeLessThan(-0.5);
  });

  it('delta direction: flat when both windows empty (delta = 0)', () => {
    const result = computeReliabilityAnalytics(db, 30);
    expect(result.firstPassRateDelta.direction).toBe('flat');
    expect(result.firstPassRateDelta.value).toBe(0);
  });

  // ── Workspace pod exclusion ─────────────────────────────────────────────────

  it('workspace pods are excluded from the cohort', () => {
    // Workspace pod — should not count
    insertPod(db, { status: 'complete', reworkCount: 0, outputMode: 'workspace' });
    // Normal pod — should count
    insertPod(db, { status: 'complete', reworkCount: 0, outputMode: 'pr' });

    const result = computeReliabilityAnalytics(db, 30);
    expect(result.summary.totalPodsInWindow).toBe(1);
  });

  // ── Build and health stage via smoke subtree ────────────────────────────────

  it('build failure in smoke.build is counted for build stage (not smoke stage)', () => {
    const podId = insertPod(db, { status: 'complete' });
    insertValidation(
      db,
      podId,
      makeValidationResult({
        smoke: {
          status: 'fail',
          build: { status: 'fail', output: 'error', duration: 100 },
          health: { status: 'pass', url: 'http://localhost/', responseCode: 200, duration: 50 },
          pages: [], // no page failures → smoke stage does NOT fail
        },
      }),
    );

    const result = computeReliabilityAnalytics(db, 30);

    const buildEntry = need(result.stageFailures.find((s) => s.stage === 'build'));
    expect(buildEntry.podsFailed).toBe(1);

    const smokeEntry = need(result.stageFailures.find((s) => s.stage === 'smoke'));
    expect(smokeEntry.podsFailed).toBe(0); // no page failures
  });

  // ── Profile heatmap sorting ─────────────────────────────────────────────────

  it('profile heatmap stages are in canonical stage order', () => {
    const podId = insertPod(db, { status: 'complete' });
    insertValidation(
      db,
      podId,
      makeValidationResult({
        test: { status: 'pass', duration: 100 },
        lint: { status: 'pass', output: '', duration: 50 },
      }),
    );

    const result = computeReliabilityAnalytics(db, 30);

    const entry = need(result.profileHeatmap[0]);
    const stageNames = entry.stages.map((s) => s.stage);
    const canonical = ['build', 'health', 'smoke', 'test', 'lint', 'sast', 'facts', 'taskReview'];
    const filtered = canonical.filter((s) => stageNames.includes(s as never));
    expect(stageNames).toEqual(filtered);
  });

  // ── topFailureStage tie-breaking ────────────────────────────────────────────

  it('topFailureStage tie-break: same rate → highest podsFailed wins', () => {
    const pod1 = insertPod(db, { status: 'complete' });
    const pod2 = insertPod(db, { status: 'complete' });

    // Both test and lint fail for pod1 (rate 1.0 each, podsFailed = 1 for each after pod2)
    // After two pods: test fails for both → rate 1.0, podsFailed 2
    //                 lint fails for pod1 only → rate 0.5, podsFailed 1
    // top failure = test (higher podsFailed)
    insertValidation(
      db,
      pod1,
      makeValidationResult({
        test: { status: 'fail', duration: 100 },
        lint: { status: 'fail', output: '', duration: 50 },
      }),
    );
    insertValidation(
      db,
      pod2,
      makeValidationResult({
        test: { status: 'fail', duration: 100 },
        lint: { status: 'pass', output: '', duration: 50 },
      }),
    );

    const result = computeReliabilityAnalytics(db, 30);
    expect(result.summary.topFailureStage).toBe('test');
  });

  // ── stageFailures always has 8 entries ──────────────────────────────────────

  it('stageFailures always has exactly 8 entries', () => {
    insertPod(db, { status: 'complete' });

    const result = computeReliabilityAnalytics(db, 30);
    expect(result.stageFailures).toHaveLength(8);
  });

  // ── funnel.bands always has 8 entries ──────────────────────────────────────

  it('funnel.bands always has exactly 8 entries in band order', () => {
    const result = computeReliabilityAnalytics(db, 30);
    expect(result.funnel.bands).toHaveLength(8);
    const bandNames = result.funnel.bands.map((b) => b.band);
    expect(bandNames).toEqual([
      'queued',
      'provisioning',
      'running',
      'validating',
      'validated',
      'approved',
      'merging',
      'complete',
    ]);
  });
});
