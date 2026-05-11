import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, insertTestProfile } from '../test-utils/mock-helpers.js';
import { computeModelsAnalytics } from './models-aggregator.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

let seq = 0;

function daysAgo(n: number): string {
  return new Date(Date.now() - n * 86_400_000).toISOString();
}

function hoursAgo(n: number): string {
  return new Date(Date.now() - n * 3_600_000).toISOString();
}

interface InsertPodOpts {
  id?: string;
  status?: string;
  model?: string;
  runtime?: string;
  completedAt?: string;
  createdAt?: string;
  outputMode?: string;
  costUsd?: number;
  inputTokens?: number;
  outputTokens?: number;
}

function insertPod(db: Database.Database, opts: InsertPodOpts = {}): string {
  const id = opts.id ?? `pod-${++seq}`;
  const now = new Date().toISOString();
  const createdAt = opts.createdAt ?? now;
  const completedAt = opts.completedAt ?? now;
  db.prepare(`
    INSERT INTO pods (
      id, profile_name, task, status, model, runtime, execution_target, branch,
      user_id, max_validation_attempts, skip_validation,
      output_mode, agent_mode, output_target, validate, promotable,
      created_at, started_at, completed_at, rework_count,
      input_tokens, output_tokens, cost_usd
    ) VALUES (
      @id, 'test-profile', 'task', @status, @model, @runtime, 'local', 'branch-1',
      'user-1', 3, 0,
      @outputMode, 'auto', 'pr', 1, 0,
      @createdAt, @createdAt, @completedAt, 0,
      @inputTokens, @outputTokens, @costUsd
    )
  `).run({
    id,
    status: opts.status ?? 'complete',
    model: opts.model ?? 'claude-opus-4-7',
    runtime: opts.runtime ?? 'claude',
    outputMode: opts.outputMode ?? 'pr',
    createdAt,
    completedAt,
    inputTokens: opts.inputTokens ?? 0,
    outputTokens: opts.outputTokens ?? 0,
    costUsd: opts.costUsd ?? 0,
  });
  return id;
}

function insertQuality(db: Database.Database, podId: string, score: number): void {
  db.prepare(`
    INSERT INTO pod_quality_scores
      (pod_id, score, runtime, profile_name, model, final_status, completed_at)
    VALUES
      (@podId, @score, 'claude', 'test-profile', 'claude-opus-4-7', 'complete', @completedAt)
  `).run({ podId, score, completedAt: new Date().toISOString() });
}

function insertEscalation(
  db: Database.Database,
  podId: string,
  type: string,
  id?: string,
): string {
  const eid = id ?? `esc-${++seq}`;
  db.prepare(`
    INSERT INTO escalations (id, pod_id, type, payload, created_at)
    VALUES (@id, @podId, @type, '{}', @createdAt)
  `).run({ id: eid, podId, type, createdAt: new Date().toISOString() });
  return eid;
}

function insertValidation(db: Database.Database, podId: string, result: object): void {
  const id = `val-${++seq}`;
  db.prepare(`
    INSERT INTO validations (id, pod_id, attempt, result, created_at)
    VALUES (@id, @podId, 1, @result, @createdAt)
  `).run({ id, podId, result: JSON.stringify(result), createdAt: new Date().toISOString() });
}

// ── Test setup ────────────────────────────────────────────────────────────────

describe('computeModelsAnalytics', () => {
  let db: Database.Database;

  beforeEach(() => {
    seq = 0;
    db = createTestDb();
    insertTestProfile(db);
  });

  afterEach(() => {
    db.close();
  });

  // ── Empty cohort ─────────────────────────────────────────────────────────

  it('empty cohort — returns zeroed-out structure', () => {
    const result = computeModelsAnalytics(db, 30);

    expect(result.summary.cheapestDollarPerPrModel).toBeNull();
    expect(result.summary.cheapestDollarPerPr).toBeNull();
    expect(result.summary.bestQualityModel).toBeNull();
    expect(result.summary.bestQuality).toBeNull();
    expect(result.summary.mostUsedModel).toBeNull();
    expect(result.summary.mostUsedPodCount).toBeNull();
    expect(result.summary.cohortSize).toBe(0);
    expect(result.summary.mostUsedDailySparkline).toHaveLength(30);
    expect(result.summary.mostUsedDailySparkline.every((s) => s.count === 0)).toBe(true);
    expect(result.summary.cheapestDollarPerPrDelta).toEqual({ value: 0, direction: 'flat' });
    expect(result.byModel).toHaveLength(0);
    expect(result.byRuntime).toHaveLength(3);
    expect(result.byRuntime.every((r) => r.podCount === 0)).toBe(true);
    expect(result.failureStageMatrix).toHaveLength(0);
    expect(result.unknownModels).toHaveLength(0);
  });

  // ── Single-model cohort ──────────────────────────────────────────────────

  it('single-model cohort — correct per-model rollup and summary', () => {
    // 7 complete, 2 killed, 1 failed = 10 total
    for (let i = 0; i < 7; i++) insertPod(db, { model: 'claude-opus-4-7', status: 'complete', costUsd: 30 / 7 });
    for (let i = 0; i < 2; i++) insertPod(db, { model: 'claude-opus-4-7', status: 'killed', costUsd: 0 });
    insertPod(db, { model: 'claude-opus-4-7', status: 'failed', costUsd: 0 });

    // 5 quality scores averaging 80: 70+80+80+80+90 = 400/5=80
    const podIds = db
      .prepare(`SELECT id FROM pods WHERE model='claude-opus-4-7' AND status='complete' LIMIT 5`)
      .all() as Array<{ id: string }>;
    const scores = [70, 80, 80, 80, 90];
    podIds.forEach((r, i) => insertQuality(db, r.id, scores[i]!));

    const result = computeModelsAnalytics(db, 30);

    expect(result.byModel).toHaveLength(1);
    const row = result.byModel[0]!;
    expect(row.model).toBe('claude-opus-4-7');
    expect(row.podCount).toBe(10);
    expect(row.completeCount).toBe(7);
    expect(row.killedCount).toBe(2);
    expect(row.failedCount).toBe(1);
    expect(row.successRate).toBeCloseTo(0.7);
    expect(row.totalCostUsd).toBeCloseTo(30, 5);
    expect(row.dollarPerPr).toBeCloseTo(30 / 7, 5);
    expect(row.scoredCount).toBe(5);
    expect(row.avgQuality).toBeCloseTo(80);

    // Summary
    expect(result.summary.cheapestDollarPerPrModel).toBe('claude-opus-4-7');
    expect(result.summary.bestQualityModel).toBe('claude-opus-4-7');
    expect(result.summary.mostUsedModel).toBe('claude-opus-4-7');
  });

  // ── Alias coalescing ─────────────────────────────────────────────────────

  it('alias coalescing — opus and claude-opus-4-7 merge into one row', () => {
    for (let i = 0; i < 6; i++) insertPod(db, { model: 'opus' });
    for (let i = 0; i < 4; i++) insertPod(db, { model: 'claude-opus-4-7' });

    const result = computeModelsAnalytics(db, 30);

    expect(result.byModel).toHaveLength(1);
    expect(result.byModel[0]!.model).toBe('claude-opus-4-7');
    expect(result.byModel[0]!.podCount).toBe(10);
  });

  // ── Unknown model bucket ─────────────────────────────────────────────────

  it('unknown model — buckets under <unknown>, cost is null, quality computes', () => {
    for (let i = 0; i < 5; i++) insertPod(db, { model: 'mystery-model-x', status: 'complete' });
    for (let i = 0; i < 5; i++) insertPod(db, { model: 'claude-opus-4-7' });

    const result = computeModelsAnalytics(db, 30);

    expect(result.byModel).toHaveLength(2);
    const unknown = result.byModel.find((r) => r.model === '<unknown>');
    expect(unknown).toBeDefined();
    expect(unknown!.podCount).toBe(5);
    expect(unknown!.totalCostUsd).toBeNull();
    expect(unknown!.dollarPerPr).toBeNull();
    expect(unknown!.completeCostUsd).toBeNull();

    const opus = result.byModel.find((r) => r.model === 'claude-opus-4-7');
    expect(opus).toBeDefined();

    expect(result.unknownModels).toEqual([{ rawModel: 'mystery-model-x', podCount: 5 }]);
  });

  // ── Unknown models cap at 10 ─────────────────────────────────────────────

  it('unknown models cap — 12 distinct strings, only 10 in unknownModels, <unknown> row has 12', () => {
    for (let i = 1; i <= 12; i++) {
      insertPod(db, { model: `unknown-model-${String(i).padStart(2, '0')}` });
    }

    const result = computeModelsAnalytics(db, 30);

    const unknown = result.byModel.find((r) => r.model === '<unknown>');
    expect(unknown!.podCount).toBe(12);
    expect(result.unknownModels).toHaveLength(10);
  });

  // ── MIN_COHORT_FOR_HEADLINE — cheapest ───────────────────────────────────

  it('MIN_COHORT_FOR_HEADLINE — haiku has 3 complete pods (< 5), excluded from cheapest headline', () => {
    // Haiku: 3 complete pods at $0.10/PR
    for (let i = 0; i < 3; i++) insertPod(db, { model: 'claude-haiku-4-5', status: 'complete', costUsd: 0.1 });
    // Opus: 100 complete pods at $5/PR
    for (let i = 0; i < 100; i++) insertPod(db, { model: 'claude-opus-4-7', status: 'complete', costUsd: 5 });

    const result = computeModelsAnalytics(db, 30);

    expect(result.summary.cheapestDollarPerPrModel).toBe('claude-opus-4-7');
    // Haiku still appears in byModel
    const haiku = result.byModel.find((r) => r.model === 'claude-haiku-4-5');
    expect(haiku).toBeDefined();
    expect(haiku!.podCount).toBe(3);
  });

  // ── MIN_COHORT_FOR_HEADLINE — best quality ───────────────────────────────

  it('MIN_COHORT_FOR_HEADLINE — haiku has 2 scored pods (< 5), excluded from best-quality headline', () => {
    // Haiku: 2 scored pods at quality 95
    for (let i = 0; i < 2; i++) {
      const pid = insertPod(db, { model: 'claude-haiku-4-5' });
      insertQuality(db, pid, 95);
    }
    // Opus: 50 scored pods at quality 80
    for (let i = 0; i < 50; i++) {
      const pid = insertPod(db, { model: 'claude-opus-4-7' });
      insertQuality(db, pid, 80);
    }

    const result = computeModelsAnalytics(db, 30);

    expect(result.summary.bestQualityModel).toBe('claude-opus-4-7');
    expect(result.summary.bestQuality).toBeCloseTo(80);
  });

  // ── Most-used has no MIN_COHORT gate ─────────────────────────────────────

  it('most-used has no MIN_COHORT gate — shows model with 2 pods', () => {
    insertPod(db, { model: 'claude-opus-4-7' });
    insertPod(db, { model: 'claude-opus-4-7' });

    const result = computeModelsAnalytics(db, 30);

    expect(result.summary.mostUsedModel).toBe('claude-opus-4-7');
    expect(result.summary.mostUsedPodCount).toBe(2);
  });

  // ── Most-used can be <unknown> ───────────────────────────────────────────

  it('most-used can be <unknown> when unpriced pods dominate', () => {
    for (let i = 0; i < 8; i++) insertPod(db, { model: 'mystery-model' });
    for (let i = 0; i < 3; i++) insertPod(db, { model: 'claude-opus-4-7' });

    const result = computeModelsAnalytics(db, 30);

    expect(result.summary.mostUsedModel).toBe('<unknown>');
  });

  // ── byRuntime always length 3 ────────────────────────────────────────────

  it('byRuntime always 3 entries in claude/codex/copilot order', () => {
    insertPod(db, { runtime: 'claude' });

    const result = computeModelsAnalytics(db, 30);

    expect(result.byRuntime).toHaveLength(3);
    expect(result.byRuntime[0]!.runtime).toBe('claude');
    expect(result.byRuntime[1]!.runtime).toBe('codex');
    expect(result.byRuntime[2]!.runtime).toBe('copilot');
    expect(result.byRuntime[1]!.podCount).toBe(0);
    expect(result.byRuntime[2]!.podCount).toBe(0);
    expect(result.byRuntime[1]!.avgQuality).toBeNull();
  });

  // ── TTM mean math ────────────────────────────────────────────────────────

  it('TTM mean — mean of 60s, 300s, 600s = 320s', () => {
    // Three complete pods with specific TTMs
    const now = Date.now();
    const insertWithTtm = (ttmSeconds: number) => {
      const completedAt = new Date(now).toISOString();
      const createdAt = new Date(now - ttmSeconds * 1000).toISOString();
      insertPod(db, { status: 'complete', createdAt, completedAt, model: 'claude-opus-4-7' });
    };
    insertWithTtm(60);
    insertWithTtm(300);
    insertWithTtm(600);

    const result = computeModelsAnalytics(db, 30);

    expect(result.byModel[0]!.meanTtmSeconds).toBeCloseTo(320, 0);
  });

  // ── TTM excludes non-complete pods ───────────────────────────────────────

  it('TTM excludes killed pods', () => {
    const now = Date.now();
    insertPod(db, {
      status: 'complete',
      createdAt: new Date(now - 60_000).toISOString(),
      completedAt: new Date(now).toISOString(),
      model: 'claude-opus-4-7',
    });
    insertPod(db, {
      status: 'killed',
      createdAt: new Date(now - 1_000_000).toISOString(),
      completedAt: new Date(now).toISOString(),
      model: 'claude-opus-4-7',
    });

    const result = computeModelsAnalytics(db, 30);

    expect(result.byModel[0]!.meanTtmSeconds).toBeCloseTo(60, 0);
  });

  // ── Quality excludes pods without a quality row ──────────────────────────

  it('quality excludes pods without a quality row — scoredCount=3, avgQuality=70', () => {
    for (let i = 0; i < 10; i++) insertPod(db, { model: 'claude-opus-4-7' });

    const pods = db
      .prepare(`SELECT id FROM pods WHERE model='claude-opus-4-7' LIMIT 3`)
      .all() as Array<{ id: string }>;
    insertQuality(db, pods[0]!.id, 60);
    insertQuality(db, pods[1]!.id, 70);
    insertQuality(db, pods[2]!.id, 80);

    const result = computeModelsAnalytics(db, 30);

    expect(result.byModel[0]!.scoredCount).toBe(3);
    expect(result.byModel[0]!.avgQuality).toBeCloseTo(70);
  });

  // ── Cost waste in totalCostUsd ───────────────────────────────────────────

  it('cost waste — totalCostUsd includes killed pods, dollarPerPr divides by completeCount', () => {
    insertPod(db, { model: 'claude-opus-4-7', status: 'complete', costUsd: 5 });
    insertPod(db, { model: 'claude-opus-4-7', status: 'killed', costUsd: 3 });

    const result = computeModelsAnalytics(db, 30);
    const row = result.byModel[0]!;

    expect(row.totalCostUsd).toBeCloseTo(8);
    expect(row.dollarPerPr).toBeCloseTo(8); // 8 / 1 complete pod
  });

  it('completeCostUsd — only complete pods', () => {
    insertPod(db, { model: 'claude-opus-4-7', status: 'complete', costUsd: 5 });
    insertPod(db, { model: 'claude-opus-4-7', status: 'killed', costUsd: 3 });

    const result = computeModelsAnalytics(db, 30);

    expect(result.byModel[0]!.completeCostUsd).toBeCloseTo(5);
  });

  // ── Escalation rate predicate ────────────────────────────────────────────

  it('escalation rate — only human-attention types count, ask_ai excluded', () => {
    const pods = [];
    for (let i = 0; i < 10; i++) pods.push(insertPod(db, { model: 'claude-opus-4-7' }));

    // 3 ask_human pods
    insertEscalation(db, pods[0]!, 'ask_human');
    insertEscalation(db, pods[1]!, 'ask_human');
    insertEscalation(db, pods[2]!, 'ask_human');
    // 1 validation_override pod
    insertEscalation(db, pods[3]!, 'validation_override');
    // excluded types
    insertEscalation(db, pods[4]!, 'ask_ai');
    insertEscalation(db, pods[5]!, 'request_credential');

    const result = computeModelsAnalytics(db, 30);
    const row = result.byModel[0]!;

    expect(row.escalatedCount).toBe(4);
    expect(row.escalationRate).toBeCloseTo(0.4);
  });

  it('escalation rate distinct-pod — 1 pod with 5 ask_human rows = escalatedCount 1', () => {
    const podId = insertPod(db, { model: 'claude-opus-4-7' });
    for (let i = 0; i < 5; i++) insertEscalation(db, podId, 'ask_human');

    const result = computeModelsAnalytics(db, 30);

    expect(result.byModel[0]!.escalatedCount).toBe(1);
  });

  // ── Failure-stage matrix shape ───────────────────────────────────────────

  it('failure-stage matrix — each row has 8 stages in fixed order', () => {
    insertPod(db, { model: 'claude-opus-4-7' });
    insertPod(db, { model: 'claude-sonnet-4-6' });

    const result = computeModelsAnalytics(db, 30);

    expect(result.failureStageMatrix).toHaveLength(2);
    for (const row of result.failureStageMatrix) {
      expect(row.stages).toHaveLength(8);
      const stageNames = row.stages.map((s) => s.stage);
      expect(stageNames).toEqual([
        'build',
        'health',
        'smoke',
        'test',
        'lint',
        'sast',
        'acValidation',
        'taskReview',
      ]);
    }
  });

  it('failure-stage matrix coalescing — opus alias merges with full ID', () => {
    for (let i = 0; i < 2; i++) {
      const pid = insertPod(db, { model: 'opus' });
      insertValidation(db, pid, {
        smoke: { build: { status: 'fail' }, health: { status: 'pass' } },
      });
    }
    for (let i = 0; i < 3; i++) {
      const pid = insertPod(db, { model: 'claude-opus-4-7' });
      insertValidation(db, pid, {
        smoke: { build: { status: 'pass' }, health: { status: 'pass' } },
      });
    }

    const result = computeModelsAnalytics(db, 30);

    expect(result.failureStageMatrix).toHaveLength(1);
    expect(result.failureStageMatrix[0]!.model).toBe('claude-opus-4-7');
    const buildCell = result.failureStageMatrix[0]!.stages.find((s) => s.stage === 'build');
    expect(buildCell!.podsRan).toBe(5); // all 5 pods ran build
    expect(buildCell!.podsFailed).toBe(2); // the 2 'opus' pods failed
  });

  it('failure-stage podsRan===0 cells — sast with no runs emits zeros not omitted', () => {
    const pid = insertPod(db, { model: 'claude-opus-4-7' });
    // Only run the build stage
    insertValidation(db, pid, { smoke: { build: { status: 'pass' } } });

    const result = computeModelsAnalytics(db, 30);

    const sastCell = result.failureStageMatrix[0]!.stages.find((s) => s.stage === 'sast');
    expect(sastCell).toEqual({ stage: 'sast', podsRan: 0, podsFailed: 0, failureRate: 0 });
  });

  // ── Sparkline most-used-only ─────────────────────────────────────────────

  it('sparkline most-used-only — sonnet pods on day 2 do not count toward opus sparkline', () => {
    const today = new Date();
    const yesterday = new Date(today.getTime() - 86_400_000);
    const todayStr = today.toISOString();
    const yesterdayStr = yesterday.toISOString();

    // 5 Opus pods completing today
    for (let i = 0; i < 5; i++) {
      insertPod(db, { model: 'claude-opus-4-7', completedAt: todayStr });
    }
    // 3 Sonnet pods completing yesterday
    for (let i = 0; i < 3; i++) {
      insertPod(db, { model: 'claude-sonnet-4-6', completedAt: yesterdayStr });
    }

    const result = computeModelsAnalytics(db, 30);

    expect(result.summary.mostUsedModel).toBe('claude-opus-4-7');
    // Today's slot should have 5 (Opus), yesterday's slot should have 0 (Sonnet doesn't count)
    const todaySlot = result.summary.mostUsedDailySparkline.at(-1);
    const yesterdaySlot = result.summary.mostUsedDailySparkline.at(-2);
    expect(todaySlot!.count).toBe(5);
    expect(yesterdaySlot!.count).toBe(0);
  });

  it('sparkline length matches days param', () => {
    insertPod(db, { model: 'claude-opus-4-7' });

    const result = computeModelsAnalytics(db, 7);

    expect(result.summary.mostUsedDailySparkline).toHaveLength(7);
  });

  // ── Trailing-window predicate ────────────────────────────────────────────

  it('outside-window pods are excluded', () => {
    // Inside window
    insertPod(db, { model: 'claude-opus-4-7', completedAt: daysAgo(1) });
    // Outside window (31 days ago for a 30-day window)
    insertPod(db, { model: 'claude-opus-4-7', completedAt: daysAgo(31) });

    const result = computeModelsAnalytics(db, 30);

    expect(result.summary.cohortSize).toBe(1);
    expect(result.byModel[0]!.podCount).toBe(1);
  });

  // ── Workspace exclusion ──────────────────────────────────────────────────

  it('workspace pods are excluded from every section', () => {
    insertPod(db, { model: 'claude-opus-4-7', outputMode: 'workspace' });
    insertPod(db, { model: 'claude-opus-4-7', outputMode: 'pr' });

    const result = computeModelsAnalytics(db, 30);

    expect(result.summary.cohortSize).toBe(1);
    expect(result.byModel[0]!.podCount).toBe(1);
  });

  // ── Prior-window delta ───────────────────────────────────────────────────

  it('prior-window delta — current $1.20/PR, prior $1.50/PR → value ≈ -0.30, direction down', () => {
    // Prior window: 31-60 days ago, 10 pods at $1.50 each
    for (let i = 0; i < 10; i++) {
      insertPod(db, {
        model: 'claude-opus-4-7',
        status: 'complete',
        costUsd: 1.5,
        completedAt: daysAgo(31 + i),
        createdAt: daysAgo(32 + i),
      });
    }
    // Current window: within last 30 days, 10 pods at $1.20 each
    for (let i = 0; i < 10; i++) {
      insertPod(db, {
        model: 'claude-opus-4-7',
        status: 'complete',
        costUsd: 1.2,
        completedAt: daysAgo(1 + i),
        createdAt: daysAgo(2 + i),
      });
    }

    const result = computeModelsAnalytics(db, 30);

    expect(result.summary.cheapestDollarPerPrDelta.value).toBeCloseTo(-0.3, 5);
    expect(result.summary.cheapestDollarPerPrDelta.direction).toBe('down');
  });

  it('prior-window null — prior window has no eligible model → flat delta', () => {
    // Only current window pods
    for (let i = 0; i < 10; i++) {
      insertPod(db, {
        model: 'claude-opus-4-7',
        status: 'complete',
        costUsd: 1.2,
        completedAt: daysAgo(1),
        createdAt: daysAgo(2),
      });
    }

    const result = computeModelsAnalytics(db, 30);

    expect(result.summary.cheapestDollarPerPrDelta).toEqual({ value: 0, direction: 'flat' });
  });
});
