/**
 * Models analytics aggregator.
 * Pure function: takes a SQLite handle and a trailing window in days,
 * returns a ModelsAnalyticsResponse. No side effects, no mutations.
 *
 * ONE COHORT — terminal cohort only:
 *   output_mode != 'workspace' AND status IN ('complete','killed','failed')
 *   AND completed_at >= datetime('now', '-' || @days || ' days')
 *
 * summary.cheapestDollarPerPrDelta.value is in ABSOLUTE USD
 * (e.g. -0.42 means $0.42 cheaper this window vs prior). Desktop formats as %+$.2f/PR.
 */
import type Database from 'better-sqlite3';
import {
  canonicalModelKey,
  effectiveCostUsd,
  type FailureStageRow,
  type ModelsAnalyticsResponse,
  type PerModelAggregate,
  type PerRuntimeAggregate,
  type UnknownModelSample,
  type ValidationStage,
} from '@autopod/shared';

// ── Constants ──────────────────────────────────────────────────────────────────

const MIN_COHORT_FOR_HEADLINE = 5;
const MAX_UNKNOWN_MODELS = 10;
const HUMAN_ATTENTION_SQL = `('ask_human','report_blocker','validation_override','action_approval')`;

const STAGES: ValidationStage[] = [
  'build',
  'health',
  'smoke',
  'test',
  'lint',
  'sast',
  'acValidation',
  'taskReview',
];

const RUNTIMES = ['claude', 'codex', 'copilot'] as const;

// ── Cohort clause ──────────────────────────────────────────────────────────────

// keep in sync with: reliability-aggregator.ts terminalCohortWhere()
function terminalCohortWhere(): string {
  return `output_mode != 'workspace'
    AND status IN ('complete', 'killed', 'failed')
    AND completed_at >= datetime('now', '-' || @days || ' days')`;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function sparklineDays(days: number): string[] {
  const nowMs = Date.now();
  return Array.from({ length: days }, (_, i) =>
    new Date(nowMs - (days - 1 - i) * 86_400_000).toISOString().slice(0, 10),
  );
}

// ── Internal types ────────────────────────────────────────────────────────────

interface PodRow {
  id: string;
  model: string | null;
  runtime: string;
  status: string;
  createdAt: string;
  completedAt: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

interface QualityRow {
  podId: string;
  score: number;
  model: string | null;
  runtime: string;
}

interface EscalationRow {
  podId: string;
  model: string | null;
  runtime: string;
}

interface ValidationRow {
  podId: string;
  result: string;
}

interface StoredValidationResult {
  smoke?: {
    build?: { status?: string };
    health?: { status?: string };
    pages?: Array<{ status?: string }>;
  };
  test?: { status?: string } | null;
  lint?: { status?: string } | null;
  sast?: { status?: string } | null;
  acValidation?: { status?: string } | null;
  taskReview?: { status?: string } | null;
}

type StageAccum = Record<ValidationStage, { ran: Set<string>; failed: Set<string> }>;

function emptyStageAccum(): StageAccum {
  return Object.fromEntries(
    STAGES.map((s) => [s, { ran: new Set<string>(), failed: new Set<string>() }]),
  ) as StageAccum;
}

interface ModelAccum {
  podCount: number;
  completeCount: number;
  killedCount: number;
  failedCount: number;
  totalCostUsd: number;
  completeCostUsd: number;
  sumTtmSeconds: number;
  scoreSum: number;
  scoredCount: number;
  escalatedPodIds: Set<string>;
  stageAccum: StageAccum;
}

interface RuntimeAccum {
  podCount: number;
  completeCount: number;
  killedCount: number;
  failedCount: number;
  totalCostUsd: number;
  sumTtmSeconds: number;
  scoreSum: number;
  scoredCount: number;
  escalatedPodIds: Set<string>;
}

// ── Empty-cohort fast path ────────────────────────────────────────────────────

function emptyResponse(days: number): ModelsAnalyticsResponse {
  const sparkline = sparklineDays(days).map((day) => ({ day, count: 0 }));
  return {
    summary: {
      cheapestDollarPerPrModel: null,
      cheapestDollarPerPr: null,
      bestQualityModel: null,
      bestQuality: null,
      mostUsedModel: null,
      mostUsedPodCount: null,
      cohortSize: 0,
      mostUsedDailySparkline: sparkline,
      cheapestDollarPerPrDelta: { value: 0, direction: 'flat' },
    },
    byModel: [],
    byRuntime: RUNTIMES.map((runtime) => ({
      runtime,
      podCount: 0,
      completeCount: 0,
      killedCount: 0,
      failedCount: 0,
      successRate: 0,
      totalCostUsd: 0,
      dollarPerPr: null,
      scoredCount: 0,
      avgQuality: null,
      meanTtmSeconds: null,
      escalatedCount: 0,
      escalationRate: 0,
    })),
    failureStageMatrix: [],
    unknownModels: [],
  };
}

// ── Prior-window cheapest $/PR helper ─────────────────────────────────────────

function cheapestDollarPerPrForWindow(
  db: Database.Database,
  startDaysAgo: number,
  endDaysAgo: number,
): number | null {
  const rows = db
    .prepare(
      `SELECT model, status,
              input_tokens AS inputTokens, output_tokens AS outputTokens, cost_usd AS costUsd
       FROM pods
       WHERE output_mode != 'workspace'
         AND status IN ('complete', 'killed', 'failed')
         AND completed_at >= datetime('now', '-' || @startDays || ' days')
         AND completed_at <  datetime('now', '-' || @endDays   || ' days')`,
    )
    .all({ startDays: startDaysAgo, endDays: endDaysAgo }) as Array<{
    model: string | null;
    status: string;
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
  }>;

  const acc = new Map<string, { totalCost: number; completeCount: number }>();
  for (const row of rows) {
    const canonical = canonicalModelKey(row.model);
    if (!canonical) continue;
    const entry = acc.get(canonical) ?? { totalCost: 0, completeCount: 0 };
    entry.totalCost += effectiveCostUsd({
      model: canonical,
      inputTokens: row.inputTokens,
      outputTokens: row.outputTokens,
      costUsd: row.costUsd,
    });
    if (row.status === 'complete') entry.completeCount++;
    acc.set(canonical, entry);
  }

  let cheapest: number | null = null;
  for (const [, data] of acc) {
    if (data.completeCount < MIN_COHORT_FOR_HEADLINE) continue;
    const dpr = data.totalCost / data.completeCount;
    if (cheapest === null || dpr < cheapest) cheapest = dpr;
  }
  return cheapest;
}

// ── Main export ───────────────────────────────────────────────────────────────

export function computeModelsAnalytics(
  db: Database.Database,
  days: number,
): ModelsAnalyticsResponse {
  // ── Main cohort query ───────────────────────────────────────────────────────
  const podRows = db
    .prepare(
      `SELECT id, model, runtime, status,
              created_at  AS createdAt,
              completed_at AS completedAt,
              input_tokens  AS inputTokens,
              output_tokens AS outputTokens,
              cost_usd      AS costUsd
       FROM pods
       WHERE ${terminalCohortWhere()}`,
    )
    .all({ days }) as PodRow[];

  if (podRows.length === 0) return emptyResponse(days);

  // ── Accumulate byModel and byRuntime ────────────────────────────────────────
  const byModelAccum = new Map<string, ModelAccum>();
  const byRuntimeAccum = new Map<string, RuntimeAccum>(
    RUNTIMES.map((rt) => [
      rt,
      {
        podCount: 0,
        completeCount: 0,
        killedCount: 0,
        failedCount: 0,
        totalCostUsd: 0,
        sumTtmSeconds: 0,
        scoreSum: 0,
        scoredCount: 0,
        escalatedPodIds: new Set(),
      },
    ]),
  );

  const unknownRaw = new Map<string, number>(); // raw model string → pod count
  const podModelMap = new Map<string, string>(); // podId → canonical model

  function getOrCreateModel(canonical: string): ModelAccum {
    let m = byModelAccum.get(canonical);
    if (!m) {
      m = {
        podCount: 0,
        completeCount: 0,
        killedCount: 0,
        failedCount: 0,
        totalCostUsd: 0,
        completeCostUsd: 0,
        sumTtmSeconds: 0,
        scoreSum: 0,
        scoredCount: 0,
        escalatedPodIds: new Set(),
        stageAccum: emptyStageAccum(),
      };
      byModelAccum.set(canonical, m);
    }
    return m;
  }

  for (const pod of podRows) {
    const canonical = canonicalModelKey(pod.model) ?? '<unknown>';
    podModelMap.set(pod.id, canonical);

    if (canonical === '<unknown>' && pod.model) {
      unknownRaw.set(pod.model, (unknownRaw.get(pod.model) ?? 0) + 1);
    }

    const mAccum = getOrCreateModel(canonical);
    mAccum.podCount++;

    const rtAccum = byRuntimeAccum.get(pod.runtime);

    // effectiveCostUsd for runtime (always accum regardless of model)
    const rtCost = effectiveCostUsd({
      model: pod.model,
      inputTokens: pod.inputTokens,
      outputTokens: pod.outputTokens,
      costUsd: pod.costUsd,
    });

    // modelCost is 0 for <unknown> (unpriced); totalCostUsd/completeCostUsd are nulled at serialization
    const modelCost =
      canonical === '<unknown>'
        ? 0
        : effectiveCostUsd({
            model: canonical,
            inputTokens: pod.inputTokens,
            outputTokens: pod.outputTokens,
            costUsd: pod.costUsd,
          });

    mAccum.totalCostUsd += modelCost;

    if (pod.status === 'complete') {
      mAccum.completeCount++;
      mAccum.completeCostUsd += modelCost;
      const ttmSeconds =
        (new Date(pod.completedAt).getTime() - new Date(pod.createdAt).getTime()) / 1000;
      mAccum.sumTtmSeconds += ttmSeconds;

      if (rtAccum) {
        rtAccum.completeCount++;
        rtAccum.totalCostUsd += rtCost;
        rtAccum.sumTtmSeconds += ttmSeconds;
      }
    } else if (pod.status === 'killed') {
      mAccum.killedCount++;
      if (rtAccum) {
        rtAccum.killedCount++;
        rtAccum.totalCostUsd += rtCost;
      }
    } else {
      mAccum.failedCount++;
      if (rtAccum) {
        rtAccum.failedCount++;
        rtAccum.totalCostUsd += rtCost;
      }
    }

    if (rtAccum) rtAccum.podCount++;
  }

  // ── Quality query ─────────────────────────────────────────────────────────
  // Uses subquery to avoid SQLITE_MAX_VARIABLE_NUMBER on large cohorts.
  const qualityRows = db
    .prepare(
      `SELECT q.pod_id AS podId, q.score, p.model, p.runtime
       FROM pod_quality_scores q
       JOIN pods p ON p.id = q.pod_id
       WHERE q.pod_id IN (SELECT id FROM pods WHERE ${terminalCohortWhere()})`,
    )
    .all({ days }) as QualityRow[];

  for (const row of qualityRows) {
    const canonical = canonicalModelKey(row.model) ?? '<unknown>';
    const mAccum = byModelAccum.get(canonical);
    if (mAccum) {
      mAccum.scoreSum += row.score;
      mAccum.scoredCount++;
    }
    const rtAccum = byRuntimeAccum.get(row.runtime);
    if (rtAccum) {
      rtAccum.scoreSum += row.score;
      rtAccum.scoredCount++;
    }
  }

  // ── Escalations query ─────────────────────────────────────────────────────
  // DISTINCT pod_id per model/runtime — one pod counts once even with many escalation rows.
  // Uses subquery to avoid SQLITE_MAX_VARIABLE_NUMBER on large cohorts.
  const escalationRows = db
    .prepare(
      `SELECT DISTINCT e.pod_id AS podId, p.model, p.runtime
       FROM escalations e
       JOIN pods p ON p.id = e.pod_id
       WHERE e.type IN ${HUMAN_ATTENTION_SQL}
         AND e.pod_id IN (SELECT id FROM pods WHERE ${terminalCohortWhere()})`,
    )
    .all({ days }) as EscalationRow[];

  for (const row of escalationRows) {
    const canonical = canonicalModelKey(row.model) ?? '<unknown>';
    byModelAccum.get(canonical)?.escalatedPodIds.add(row.podId);
    byRuntimeAccum.get(row.runtime)?.escalatedPodIds.add(row.podId);
  }

  // ── Validations query (failure-stage matrix) ───────────────────────────────
  // Mirror reliability-aggregator.ts profileHeatmap accumulation, keyed by canonical model.
  // Uses subquery to avoid SQLITE_MAX_VARIABLE_NUMBER on large cohorts.
  const validationRows = db
    .prepare(
      `SELECT pod_id AS podId, result
       FROM validations
       WHERE pod_id IN (SELECT id FROM pods WHERE ${terminalCohortWhere()})`,
    )
    .all({ days }) as ValidationRow[];

  for (const row of validationRows) {
    const canonical = podModelMap.get(row.podId);
    if (!canonical) continue;

    const mAccum = byModelAccum.get(canonical);
    if (!mAccum) continue;

    let parsed: StoredValidationResult;
    try {
      parsed = JSON.parse(row.result) as StoredValidationResult;
    } catch {
      continue;
    }

    const sa = mAccum.stageAccum;

    if (parsed.smoke?.build !== undefined) {
      sa.build.ran.add(row.podId);
      if (parsed.smoke.build.status === 'fail') sa.build.failed.add(row.podId);
    }
    if (parsed.smoke?.health !== undefined) {
      sa.health.ran.add(row.podId);
      if (parsed.smoke.health.status === 'fail') sa.health.failed.add(row.podId);
    }
    if (parsed.smoke?.pages !== undefined) {
      sa.smoke.ran.add(row.podId);
      if (parsed.smoke.pages.some((pg) => pg.status === 'fail')) sa.smoke.failed.add(row.podId);
    }
    for (const stage of ['test', 'lint', 'sast'] as const) {
      const sr = parsed[stage];
      if (sr !== undefined && sr !== null) {
        sa[stage].ran.add(row.podId);
        if (sr.status === 'fail') sa[stage].failed.add(row.podId);
      }
    }
    if (parsed.acValidation !== undefined && parsed.acValidation !== null) {
      sa.acValidation.ran.add(row.podId);
      if (parsed.acValidation.status === 'fail') sa.acValidation.failed.add(row.podId);
    }
    if (parsed.taskReview !== undefined && parsed.taskReview !== null) {
      sa.taskReview.ran.add(row.podId);
      if (parsed.taskReview.status === 'fail') sa.taskReview.failed.add(row.podId);
    }
  }

  // ── Sparkline and prior-window delta ──────────────────────────────────────

  // Find most-used model (no MIN_COHORT gate)
  let mostUsedModel: string | null = null;
  let mostUsedPodCount: number | null = null;
  for (const [model, accum] of byModelAccum) {
    if (mostUsedPodCount === null || accum.podCount > mostUsedPodCount) {
      mostUsedModel = model;
      mostUsedPodCount = accum.podCount;
    }
  }

  // Sparkline: daily pod count for most-used model only
  const dayBuckets = new Map<string, number>();
  if (mostUsedModel) {
    for (const pod of podRows) {
      const canonical = podModelMap.get(pod.id);
      if (canonical !== mostUsedModel) continue;
      const day = pod.completedAt.slice(0, 10);
      dayBuckets.set(day, (dayBuckets.get(day) ?? 0) + 1);
    }
  }
  const mostUsedDailySparkline = sparklineDays(days).map((day) => ({
    day,
    count: dayBuckets.get(day) ?? 0,
  }));

  // Prior-window delta
  let currentCheapest: { model: string; dpr: number } | null = null;
  for (const [model, accum] of byModelAccum) {
    if (model === '<unknown>') continue;
    if (accum.completeCount < MIN_COHORT_FOR_HEADLINE) continue;
    const dpr = accum.totalCostUsd / accum.completeCount;
    if (currentCheapest === null || dpr < currentCheapest.dpr) currentCheapest = { model, dpr };
  }

  const priorCheapest = cheapestDollarPerPrForWindow(db, days * 2, days);

  let cheapestDollarPerPrDelta: ModelsAnalyticsResponse['summary']['cheapestDollarPerPrDelta'];
  if (currentCheapest === null || priorCheapest === null) {
    cheapestDollarPerPrDelta = { value: 0, direction: 'flat' };
  } else {
    const delta = currentCheapest.dpr - priorCheapest;
    cheapestDollarPerPrDelta = {
      value: delta,
      direction: delta < -0.005 ? 'down' : delta > 0.005 ? 'up' : 'flat',
    };
  }

  // ── Build byModel[] ────────────────────────────────────────────────────────

  const byModel: PerModelAggregate[] = [...byModelAccum.entries()]
    .sort(([aModel, aAccum], [bModel, bAccum]) => {
      const diff = bAccum.podCount - aAccum.podCount;
      return diff !== 0 ? diff : aModel.localeCompare(bModel);
    })
    .map(([model, accum]) => {
      const isUnknown = model === '<unknown>';
      return {
        model,
        podCount: accum.podCount,
        completeCount: accum.completeCount,
        killedCount: accum.killedCount,
        failedCount: accum.failedCount,
        successRate: accum.completeCount / accum.podCount,
        totalCostUsd: isUnknown ? null : accum.totalCostUsd,
        dollarPerPr:
          isUnknown || accum.completeCount === 0
            ? null
            : accum.totalCostUsd / accum.completeCount,
        scoredCount: accum.scoredCount,
        avgQuality: accum.scoredCount > 0 ? accum.scoreSum / accum.scoredCount : null,
        meanTtmSeconds:
          accum.completeCount > 0 ? accum.sumTtmSeconds / accum.completeCount : null,
        escalatedCount: accum.escalatedPodIds.size,
        escalationRate: accum.escalatedPodIds.size / accum.podCount,
        completeCostUsd: isUnknown ? null : accum.completeCostUsd,
      };
    });

  // ── Build byRuntime[] ──────────────────────────────────────────────────────

  const byRuntime: PerRuntimeAggregate[] = RUNTIMES.map((runtime) => {
    const accum = byRuntimeAccum.get(runtime)!;
    return {
      runtime,
      podCount: accum.podCount,
      completeCount: accum.completeCount,
      killedCount: accum.killedCount,
      failedCount: accum.failedCount,
      successRate: accum.podCount > 0 ? accum.completeCount / accum.podCount : 0,
      totalCostUsd: accum.totalCostUsd,
      dollarPerPr:
        accum.podCount > 0 && accum.completeCount > 0
          ? accum.totalCostUsd / accum.completeCount
          : null,
      scoredCount: accum.scoredCount,
      avgQuality: accum.scoredCount > 0 ? accum.scoreSum / accum.scoredCount : null,
      meanTtmSeconds:
        accum.completeCount > 0 ? accum.sumTtmSeconds / accum.completeCount : null,
      escalatedCount: accum.escalatedPodIds.size,
      escalationRate:
        accum.podCount > 0 ? accum.escalatedPodIds.size / accum.podCount : 0,
    };
  });

  // ── Build failureStageMatrix[] ─────────────────────────────────────────────

  const failureStageMatrix: FailureStageRow[] = byModel.map(({ model }) => {
    const sa = byModelAccum.get(model)!.stageAccum;
    return {
      model,
      stages: STAGES.map((stage) => {
        const podsRan = sa[stage].ran.size;
        const podsFailed = sa[stage].failed.size;
        return {
          stage,
          podsRan,
          podsFailed,
          failureRate: podsRan > 0 ? podsFailed / podsRan : 0,
        };
      }),
    };
  });

  // ── Build unknownModels[] ──────────────────────────────────────────────────

  const unknownModels: UnknownModelSample[] = [...unknownRaw.entries()]
    .sort(([aModel, aCount], [bModel, bCount]) => {
      const diff = bCount - aCount;
      return diff !== 0 ? diff : aModel.localeCompare(bModel);
    })
    .slice(0, MAX_UNKNOWN_MODELS)
    .map(([rawModel, podCount]) => ({ rawModel, podCount }));

  // ── Build summary ──────────────────────────────────────────────────────────

  let bestQualityModel: string | null = null;
  let bestQuality: number | null = null;
  for (const row of byModel) {
    if (row.model === '<unknown>') continue;
    if (row.scoredCount < MIN_COHORT_FOR_HEADLINE) continue;
    if (row.avgQuality === null) continue;
    if (bestQuality === null || row.avgQuality > bestQuality) {
      bestQuality = row.avgQuality;
      bestQualityModel = row.model;
    }
  }

  const cohortSize = podRows.length;

  return {
    summary: {
      cheapestDollarPerPrModel: currentCheapest?.model ?? null,
      cheapestDollarPerPr: currentCheapest?.dpr ?? null,
      bestQualityModel,
      bestQuality,
      mostUsedModel,
      mostUsedPodCount,
      cohortSize,
      mostUsedDailySparkline,
      cheapestDollarPerPrDelta,
    },
    byModel,
    byRuntime,
    failureStageMatrix,
    unknownModels,
  };
}

