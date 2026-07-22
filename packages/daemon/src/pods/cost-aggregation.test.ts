import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb, insertTestProfile } from '../test-utils/mock-helpers.js';
import { aggregateCost, parseDays } from './cost-aggregation.js';
import { computePodCostBreakdown } from './pod-cost-breakdown.js';
import { createPodRepository } from './pod-repository.js';
import type { PodRepository } from './pod-repository.js';

// ---------------------------------------------------------------------------
// Helper to insert a minimal terminal pod directly via SQL
// ---------------------------------------------------------------------------

interface InsertPodOptions {
  id?: string;
  profileName?: string;
  status?: string;
  model?: string;
  costUsd?: number;
  inputTokens?: number;
  outputTokens?: number;
  completedAt?: string;
  phaseTokenUsage?: Record<string, unknown> | null;
  outputMode?: string;
  agentMode?: string;
}

let podCounter = 0;

function insertPod(db: Database.Database, opts: InsertPodOptions = {}): string {
  const id = opts.id ?? `pod-${++podCounter}`;
  db.prepare(`
    INSERT INTO pods (
      id, profile_name, task, status, model, runtime, execution_target, branch,
      user_id, max_validation_attempts, skip_validation,
      output_mode, agent_mode, output_target, validate, promotable,
      cost_usd, input_tokens, output_tokens, completed_at, phase_token_usage
    ) VALUES (
      @id, @profileName, 'test task', @status, @model, 'claude', 'local', 'branch-1',
      'user-1', 3, 0,
      @outputMode, @agentMode, 'pr', 1, 0,
      @costUsd, @inputTokens, @outputTokens, @completedAt, @phaseTokenUsage
    )
  `).run({
    id,
    profileName: opts.profileName ?? 'test-profile',
    status: opts.status ?? 'complete',
    model: opts.model ?? 'claude-opus-4-7',
    outputMode: opts.outputMode ?? 'pr',
    agentMode: opts.agentMode ?? 'auto',
    costUsd: opts.costUsd ?? 0,
    inputTokens: opts.inputTokens ?? 0,
    outputTokens: opts.outputTokens ?? 0,
    completedAt: opts.completedAt ?? new Date().toISOString(),
    phaseTokenUsage:
      opts.phaseTokenUsage !== undefined ? JSON.stringify(opts.phaseTokenUsage) : null,
  });
  return id;
}

// ---------------------------------------------------------------------------
// Shared fixture: a reference "now" so tests are deterministic
// ---------------------------------------------------------------------------

// now = 2024-06-15T12:00:00.000Z
const NOW_MS = Date.UTC(2024, 5, 15, 12, 0, 0, 0);
const nowFn = () => new Date(NOW_MS);
// windowStart for 30-day window
const WINDOW_START_MS = NOW_MS - 30 * 86_400_000;
const WINDOW_START_ISO = new Date(WINDOW_START_MS).toISOString();
const PRIOR_START_MS = WINDOW_START_MS - 30 * 86_400_000;
const PRIOR_START_ISO = new Date(PRIOR_START_MS).toISOString();

function msToIso(ms: number): string {
  return new Date(ms).toISOString();
}

describe('aggregateCost', () => {
  let db: Database.Database;
  let podRepo: PodRepository;

  beforeEach(() => {
    podCounter = 0;
    db = createTestDb();
    insertTestProfile(db);
    podRepo = createPodRepository(db);
  });

  afterEach(() => {
    db.close();
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Empty DB
  // ──────────────────────────────────────────────────────────────────────────

  it('empty DB returns zero-value response', () => {
    const result = aggregateCost({ podRepo, now: nowFn }, { days: 30 });
    expect(result.total).toBe(0);
    expect(result.sparkline).toHaveLength(30);
    expect(result.sparkline.every((s) => s.costUsd === 0)).toBe(true);
    expect(result.deltaVsPrior).toEqual({ value: 0, direction: 'flat' });
    expect(result.byPhase).toEqual([]);
    expect(result.byProfileModel).toEqual([]);
    expect(result.top10).toEqual([]);
    expect(result.waste).toEqual({ total: 0, podCount: 0 });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Sparkline length
  // ──────────────────────────────────────────────────────────────────────────

  it.each([1, 7, 30, 365])('sparkline length matches days=%i param', (days) => {
    const result = aggregateCost({ podRepo, now: nowFn }, { days });
    expect(result.sparkline).toHaveLength(days);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Window boundaries
  // ──────────────────────────────────────────────────────────────────────────

  it('pod at windowStart is included in current window', () => {
    insertPod(db, { costUsd: 5, completedAt: WINDOW_START_ISO });
    const result = aggregateCost({ podRepo, now: nowFn }, { days: 30 });
    expect(result.total).toBe(5);
  });

  it('pod at windowStart - 1ms is in prior window only', () => {
    insertPod(db, { costUsd: 5, completedAt: msToIso(WINDOW_START_MS - 1) });
    const result = aggregateCost({ podRepo, now: nowFn }, { days: 30 });
    expect(result.total).toBe(0);
    // It should affect prior total → deltaVsPrior
    expect(result.deltaVsPrior.value).toBe(-5); // current(0) - prior(5)
    expect(result.deltaVsPrior.direction).toBe('down');
  });

  it('pod before priorStart is ignored entirely', () => {
    insertPod(db, { costUsd: 5, completedAt: msToIso(PRIOR_START_MS - 1) });
    const result = aggregateCost({ podRepo, now: nowFn }, { days: 30 });
    expect(result.total).toBe(0);
    expect(result.deltaVsPrior.value).toBe(0);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Effective cost paths
  // ──────────────────────────────────────────────────────────────────────────

  it('uses recorded costUsd when > 0 (Claude path)', () => {
    insertPod(db, {
      model: 'claude-opus-4-7',
      costUsd: 5.0,
      inputTokens: 10_000_000,
      outputTokens: 10_000_000,
      completedAt: msToIso(WINDOW_START_MS + 1),
    });
    const result = aggregateCost({ podRepo, now: nowFn }, { days: 30 });
    expect(result.total).toBe(5.0);
  });

  it('computes cost from tokens when costUsd is 0 (non-Claude path)', () => {
    insertPod(db, {
      model: 'gpt-5',
      costUsd: 0,
      inputTokens: 1_000_000,
      outputTokens: 0,
      completedAt: msToIso(WINDOW_START_MS + 1),
    });
    const result = aggregateCost({ podRepo, now: nowFn }, { days: 30 });
    expect(result.total).toBe(1.25);
  });

  it('prices a historical model alias without reporting it as unknown', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    insertPod(db, {
      model: 'opus',
      costUsd: 0,
      inputTokens: 1_000_000,
      outputTokens: 0,
      completedAt: msToIso(WINDOW_START_MS + 1),
    });

    const result = aggregateCost({ podRepo, now: nowFn }, { days: 30 });

    expect(result.total).toBe(5);
    expect(warnSpy).not.toHaveBeenCalledWith(expect.stringContaining('opus'));
    warnSpy.mockRestore();
  });

  it('returns 0 cost for unknown model and warns', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    insertPod(db, {
      model: 'unknown-foo',
      costUsd: 0,
      inputTokens: 1_000_000,
      outputTokens: 0,
      completedAt: msToIso(WINDOW_START_MS + 1),
    });
    const result = aggregateCost({ podRepo, now: nowFn }, { days: 30 });
    expect(result.total).toBe(0);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('unknown-foo'));
    warnSpy.mockRestore();
  });

  // ──────────────────────────────────────────────────────────────────────────
  // byPhase ordering
  // ──────────────────────────────────────────────────────────────────────────

  it('orders byPhase correctly: agent_initial, rework_1, rework_2, review', () => {
    // gpt-5: inputPer1M = 1.25
    insertPod(db, {
      model: 'gpt-5',
      costUsd: 3.75,
      inputTokens: 4_000_000, // total tokens across phases
      outputTokens: 0,
      completedAt: msToIso(WINDOW_START_MS + 1),
      phaseTokenUsage: {
        agent_rework_2: { inputTokens: 1_000_000, outputTokens: 0 },
        agent_initial: { inputTokens: 1_000_000, outputTokens: 0 },
        agent_rework_1: { inputTokens: 1_000_000, outputTokens: 0 },
        review: { inputTokens: 1_000_000, outputTokens: 0 },
      },
    });
    const result = aggregateCost({ podRepo, now: nowFn }, { days: 30 });
    const phases = result.byPhase.map((p) => p.phase);
    expect(phases).toEqual(['agent_initial', 'agent_rework_1', 'agent_rework_2', 'review']);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // agent_legacy reconstruction
  // ──────────────────────────────────────────────────────────────────────────

  it('pre-Phase-1 pod with no phaseTokenUsage → entire cost goes to agent_legacy', () => {
    insertPod(db, {
      costUsd: 10.0,
      completedAt: msToIso(WINDOW_START_MS + 1),
      phaseTokenUsage: null,
    });
    const result = aggregateCost({ podRepo, now: nowFn }, { days: 30 });
    expect(result.byPhase).toHaveLength(1);
    expect(result.byPhase[0]).toEqual({ phase: 'agent_legacy', costUsd: 10.0 });
  });

  it('pod with costUsd > sum of phase bucket costs → remainder goes to agent_legacy', () => {
    // gpt-5 inputPer1M=1.25, so 1M input tokens = $1.25 per bucket
    // Phase buckets sum to $7.00 → need 7M/1.25 = 5.6M tokens? Let me use a different model.
    // Use claude-sonnet-4-6: inputPer1M=3.0, outputPer1M=15.0
    // costUsd=10.0, phase buckets: agent_initial 1M input = $3.0, agent_rework_1 = 1M input = $3.0 → $6.0
    // Gap: $10.0 - $6.0 = $4.0 → nope, let me set up to get exactly $7.00 in phases
    // Use gpt-5: 4M input = $5.00, 0.2M output = $2.00 → $7.00
    insertPod(db, {
      model: 'gpt-5',
      costUsd: 10.0, // vendor reported more (e.g. cache reads)
      inputTokens: 0,
      outputTokens: 0,
      completedAt: msToIso(WINDOW_START_MS + 1),
      phaseTokenUsage: {
        agent_initial: { inputTokens: 4_000_000, outputTokens: 0 }, // 4M * 1.25/M = $5.00
        review: { inputTokens: 0, outputTokens: 200_000 }, // 0.2M * 10.0/M = $2.00
      },
    });
    const result = aggregateCost({ podRepo, now: nowFn }, { days: 30 });
    const legacy = result.byPhase.find((p) => p.phase === 'agent_legacy');
    // effective agent cost = 10.0; agent phase cost = 5.0; review is harness-side.
    if (!legacy) throw new Error('expected agent_legacy phase');
    expect(legacy.costUsd).toBeCloseTo(5.0);
  });

  it('scales phase costs down when cached vendor cost is below raw phase pricing', () => {
    insertPod(db, {
      model: 'gpt-5',
      costUsd: 2.0,
      inputTokens: 2_000_000,
      outputTokens: 0,
      completedAt: msToIso(WINDOW_START_MS + 1),
      phaseTokenUsage: {
        agent_initial: { inputTokens: 1_000_000, outputTokens: 0 },
        agent_rework_1: { inputTokens: 1_000_000, outputTokens: 0 },
      },
    });

    const result = aggregateCost({ podRepo, now: nowFn }, { days: 30 });
    const initial = result.byPhase.find((p) => p.phase === 'agent_initial');
    const rework = result.byPhase.find((p) => p.phase === 'agent_rework_1');
    const legacy = result.byPhase.find((p) => p.phase === 'agent_legacy');

    expect(result.total).toBe(2.0);
    expect(initial?.costUsd).toBeCloseTo(1.0);
    expect(rework?.costUsd).toBeCloseTo(1.0);
    expect(legacy).toBeUndefined();
    expect(result.byPhase.reduce((sum, p) => sum + p.costUsd, 0)).toBeCloseTo(result.total);
  });

  it('uses cached input tokens when computing phase costs', () => {
    insertPod(db, {
      model: 'gpt-5',
      costUsd: 0,
      inputTokens: 0,
      outputTokens: 0,
      completedAt: msToIso(WINDOW_START_MS + 1),
      phaseTokenUsage: {
        review: { inputTokens: 1_000_000, cachedInputTokens: 800_000, outputTokens: 0 },
      },
    });

    const result = aggregateCost({ podRepo, now: nowFn }, { days: 30 });
    const review = result.byPhase.find((p) => p.phase === 'review');

    expect(result.total).toBe(0.35);
    expect(review?.costUsd).toBeCloseTo(0.35);
  });

  it('uses exact phase cost when a runner reports it', () => {
    insertPod(db, {
      model: 'claude-sonnet-4-6',
      costUsd: 1.75,
      inputTokens: 1_000_000,
      outputTokens: 0,
      completedAt: msToIso(WINDOW_START_MS + 1),
      phaseTokenUsage: {
        review: { inputTokens: 10_000, outputTokens: 500, costUsd: 0.25 },
      },
    });

    const result = aggregateCost({ podRepo, now: nowFn }, { days: 30 });
    const review = result.byPhase.find((p) => p.phase === 'review');

    expect(review?.costUsd).toBeCloseTo(0.25);
    expect(result.total).toBeCloseTo(2.0);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Skip zero-cost segments
  // ──────────────────────────────────────────────────────────────────────────

  it('does not emit zero-cost phase segments', () => {
    insertPod(db, {
      model: 'gpt-5',
      costUsd: 0,
      inputTokens: 1_000_000,
      outputTokens: 0,
      completedAt: msToIso(WINDOW_START_MS + 1),
      phaseTokenUsage: {
        agent_initial: { inputTokens: 1_000_000, outputTokens: 0 },
        review: { inputTokens: 0, outputTokens: 0 }, // zero → should be skipped
      },
    });
    const result = aggregateCost({ podRepo, now: nowFn }, { days: 30 });
    const phases = result.byPhase.map((p) => p.phase);
    expect(phases).not.toContain('review');
    expect(phases).toContain('agent_initial');
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Waste filter
  // ──────────────────────────────────────────────────────────────────────────

  it('waste includes killed, failed, rejected but not complete', () => {
    const ts = msToIso(WINDOW_START_MS + 1);
    insertPod(db, { costUsd: 10, status: 'killed', completedAt: ts });
    insertPod(db, { costUsd: 5, status: 'failed', completedAt: ts });
    insertPod(db, { costUsd: 3, status: 'rejected', completedAt: ts });
    insertPod(db, { costUsd: 20, status: 'complete', completedAt: ts });
    const result = aggregateCost({ podRepo, now: nowFn }, { days: 30 });
    expect(result.waste.total).toBeCloseTo(18);
    expect(result.waste.podCount).toBe(3);
    // Total includes complete pod too
    expect(result.total).toBeCloseTo(38);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Top-10 ordering and limit
  // ──────────────────────────────────────────────────────────────────────────

  it('top10 contains at most 10 pods sorted by cost desc', () => {
    const ts = msToIso(WINDOW_START_MS + 1);
    // Insert 15 pods with costs 1..15
    for (let i = 1; i <= 15; i++) {
      insertPod(db, { costUsd: i, completedAt: ts });
    }
    const result = aggregateCost({ podRepo, now: nowFn }, { days: 30 });
    expect(result.top10).toHaveLength(10);
    // Should be sorted descending by cost
    const [first, , , , , , , , , tenth] = result.top10;
    expect(first?.costUsd).toBe(15);
    expect(tenth?.costUsd).toBe(6);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Workspace pod exclusion
  // ──────────────────────────────────────────────────────────────────────────

  it('workspace pods (agentMode=interactive) are excluded', () => {
    const ts = msToIso(WINDOW_START_MS + 1);
    insertPod(db, {
      costUsd: 100,
      completedAt: ts,
      outputMode: 'workspace',
      agentMode: 'interactive',
    });
    insertPod(db, { costUsd: 5, completedAt: ts });
    const result = aggregateCost({ podRepo, now: nowFn }, { days: 30 });
    expect(result.total).toBe(5);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Non-terminal pod exclusion
  // ──────────────────────────────────────────────────────────────────────────

  it('non-terminal pods are excluded', () => {
    const ts = msToIso(WINDOW_START_MS + 1);
    insertPod(db, { costUsd: 100, status: 'running', completedAt: ts });
    insertPod(db, { costUsd: 5, status: 'complete', completedAt: ts });
    const result = aggregateCost({ podRepo, now: nowFn }, { days: 30 });
    expect(result.total).toBe(5);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // deltaVsPrior thresholds
  // ──────────────────────────────────────────────────────────────────────────

  it.each([
    { currentCost: 110, priorCost: 100, direction: 'up' as const, value: 10 },
    { currentCost: 93, priorCost: 100, direction: 'down' as const, value: -7 },
    { currentCost: 103, priorCost: 100, direction: 'flat' as const, value: 3 },
    { currentCost: 0, priorCost: 0, direction: 'flat' as const, value: 0 },
    { currentCost: 50, priorCost: 0, direction: 'up' as const, value: 50 },
  ])(
    'prior=$priorCost, current=$currentCost → direction=$direction',
    ({ currentCost, priorCost, direction, value }) => {
      // Insert prior pod in prior window (just before windowStart)
      if (priorCost > 0) {
        insertPod(db, { costUsd: priorCost, completedAt: msToIso(WINDOW_START_MS - 1) });
      }
      if (currentCost > 0) {
        insertPod(db, { costUsd: currentCost, completedAt: msToIso(WINDOW_START_MS + 1) });
      }
      const result = aggregateCost({ podRepo, now: nowFn }, { days: 30 });
      expect(result.deltaVsPrior.direction).toBe(direction);
      expect(result.deltaVsPrior.value).toBeCloseTo(value);
    },
  );
});

describe('computePodCostBreakdown', () => {
  let db: Database.Database;
  let podRepo: PodRepository;

  beforeEach(() => {
    podCounter = 0;
    db = createTestDb();
    insertTestProfile(db);
    podRepo = createPodRepository(db);
  });

  afterEach(() => {
    db.close();
  });

  it('groups phase token usage into coarse per-pod cost buckets', () => {
    const podId = insertPod(db, {
      model: 'gpt-5',
      costUsd: 10,
      inputTokens: 5_000_000,
      outputTokens: 0,
      phaseTokenUsage: {
        agent_initial: { inputTokens: 1_000_000, outputTokens: 0 },
        agent_rework_1: { inputTokens: 1_000_000, outputTokens: 0 },
        review: { inputTokens: 1_000_000, outputTokens: 0 },
        plan_eval: { inputTokens: 1_000_000, outputTokens: 0 },
        advisory: { inputTokens: 1_000_000, outputTokens: 0 },
      },
    });

    const result = computePodCostBreakdown(podRepo.getOrThrow(podId));

    expect(result.totalCostUsd).toBe(13.75);
    expect(result.inputTokens).toBe(5_000_000);
    expect(result.outputTokens).toBe(0);
    expect(result.segments.map((segment) => segment.bucket)).toEqual([
      'work',
      'rework',
      'validation',
      'advisory',
      'unattributed',
    ]);
    expect(result.segments.find((segment) => segment.bucket === 'work')).toMatchObject({
      costUsd: 1.25,
      inputTokens: 1_000_000,
      sourcePhases: ['agent_initial'],
    });
    expect(result.segments.find((segment) => segment.bucket === 'rework')).toMatchObject({
      costUsd: 1.25,
      inputTokens: 1_000_000,
      sourcePhases: ['agent_rework_1'],
    });
    expect(result.segments.find((segment) => segment.bucket === 'validation')).toMatchObject({
      costUsd: 2.5,
      inputTokens: 2_000_000,
      sourcePhases: ['review', 'plan_eval'],
    });
    expect(result.segments.find((segment) => segment.bucket === 'advisory')).toMatchObject({
      costUsd: 1.25,
      inputTokens: 1_000_000,
      sourcePhases: ['advisory'],
    });
    expect(result.segments.find((segment) => segment.bucket === 'unattributed')).toMatchObject({
      costUsd: 7.5,
      inputTokens: 0,
      outputTokens: 0,
      sourcePhases: ['agent_legacy'],
    });
  });

  it('keeps segment costs reconciled when recorded cached cost is lower than raw pricing', () => {
    const podId = insertPod(db, {
      model: 'gpt-5',
      costUsd: 2,
      inputTokens: 2_000_000,
      outputTokens: 0,
      phaseTokenUsage: {
        agent_initial: { inputTokens: 1_000_000, outputTokens: 0 },
        agent_rework_1: { inputTokens: 1_000_000, outputTokens: 0 },
      },
    });

    const result = computePodCostBreakdown(podRepo.getOrThrow(podId));
    const work = result.segments.find((segment) => segment.bucket === 'work');
    const rework = result.segments.find((segment) => segment.bucket === 'rework');
    const unattributed = result.segments.find((segment) => segment.bucket === 'unattributed');

    expect(result.totalCostUsd).toBe(2);
    expect(work?.costUsd).toBeCloseTo(1);
    expect(rework?.costUsd).toBeCloseTo(1);
    expect(unattributed?.costUsd).toBe(0);
    expect(result.segments.reduce((sum, segment) => sum + segment.costUsd, 0)).toBeCloseTo(
      result.totalCostUsd,
    );
  });

  it('uses cached input tokens when computing segment costs', () => {
    const podId = insertPod(db, {
      model: 'gpt-5',
      costUsd: 0,
      inputTokens: 0,
      outputTokens: 0,
      phaseTokenUsage: {
        review: { inputTokens: 1_000_000, cachedInputTokens: 800_000, outputTokens: 0 },
      },
    });

    const result = computePodCostBreakdown(podRepo.getOrThrow(podId));
    const validation = result.segments.find((segment) => segment.bucket === 'validation');

    expect(result.totalCostUsd).toBe(0.35);
    expect(validation?.costUsd).toBeCloseTo(0.35);
  });

  it('uses exact phase cost when computing segment costs', () => {
    const podId = insertPod(db, {
      model: 'claude-sonnet-4-6',
      costUsd: 1.75,
      inputTokens: 1_000_000,
      outputTokens: 0,
      phaseTokenUsage: {
        review: { inputTokens: 10_000, outputTokens: 500, costUsd: 0.25 },
      },
    });

    const result = computePodCostBreakdown(podRepo.getOrThrow(podId));
    const validation = result.segments.find((segment) => segment.bucket === 'validation');

    expect(validation?.costUsd).toBeCloseTo(0.25);
    expect(result.totalCostUsd).toBeCloseTo(2.0);
  });

  it('puts legacy pods with no phase token usage into unattributed', () => {
    const podId = insertPod(db, {
      model: 'gpt-5',
      costUsd: 8,
      inputTokens: 1_000_000,
      outputTokens: 0,
      phaseTokenUsage: null,
    });

    const result = computePodCostBreakdown(podRepo.getOrThrow(podId));

    expect(result.totalCostUsd).toBe(8);
    expect(
      result.segments
        .filter((segment) => segment.bucket !== 'unattributed')
        .every((segment) => segment.costUsd === 0),
    ).toBe(true);
    expect(result.segments.find((segment) => segment.bucket === 'unattributed')).toMatchObject({
      costUsd: 8,
    });
  });

  it('returns zero computed costs for unknown models without recorded vendor cost', () => {
    const podId = insertPod(db, {
      model: 'unknown-model',
      costUsd: 0,
      inputTokens: 1_000_000,
      outputTokens: 0,
      phaseTokenUsage: {
        agent_initial: { inputTokens: 1_000_000, outputTokens: 0 },
      },
    });

    const result = computePodCostBreakdown(podRepo.getOrThrow(podId));

    expect(result.totalCostUsd).toBe(0);
    expect(result.segments.every((segment) => segment.costUsd === 0)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// parseDays
// ---------------------------------------------------------------------------

describe('parseDays', () => {
  it('returns 30 when days is missing', () => {
    expect(parseDays({})).toBe(30);
  });

  it('returns the integer when days is a valid positive integer string', () => {
    expect(parseDays({ days: '7' })).toBe(7);
    expect(parseDays({ days: '1' })).toBe(1);
    expect(parseDays({ days: '365' })).toBe(365);
  });

  it('returns null for 0', () => {
    expect(parseDays({ days: '0' })).toBeNull();
  });

  it('returns null for negative values', () => {
    expect(parseDays({ days: '-1' })).toBeNull();
  });

  it('returns null for non-integer string', () => {
    expect(parseDays({ days: 'abc' })).toBeNull();
    expect(parseDays({ days: '1.5' })).toBeNull();
  });
});
