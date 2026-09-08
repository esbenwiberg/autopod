/**
 * Reliability funnel + stage failure analytics aggregator.
 * Pure function: takes a SQLite handle and a trailing window in days,
 * returns a ReliabilityAnalyticsResponse. No side effects, no mutations.
 */
import type Database from 'better-sqlite3';
import { isExecutedFirstPass, validationCoverage } from './validation-coverage.js';

// ── Types (local — not exported through @autopod/shared) ──────────────────────

export type FunnelBand =
  | 'queued'
  | 'provisioning'
  | 'running'
  | 'validating'
  | 'validated'
  | 'approved'
  | 'merging'
  | 'complete';

export type FinalStatus = 'complete' | 'killed' | 'failed';

export type ValidationStage =
  | 'build'
  | 'health'
  | 'smoke'
  | 'test'
  | 'lint'
  | 'sast'
  | 'facts'
  | 'taskReview';

export interface ReliabilityAnalyticsResponse {
  /** Complete, no-rework pods whose first recorded validation executed and passed, divided by all terminal non-workspace pods in the window. */
  firstPassRate: number;
  /** One entry per day in window. Length == days. */
  firstPassRateSparkline: Array<{ day: string; rate: number }>;
  firstPassRateDelta: {
    value: number; // signed pp diff
    direction: 'up' | 'down' | 'flat';
  };
  funnel: {
    /** Always 8 entries, in band order. */
    bands: Array<{ band: FunnelBand; count: number }>;
    /** Drops aggregated by (from-band, finalStatus). */
    drops: Array<{
      from: FunnelBand;
      to: FinalStatus;
      count: number;
      topPods: Array<{
        podId: string;
        profile: string;
        finalStatus: FinalStatus;
        completedAt: string;
        historyArchived?: boolean;
      }>;
      overflow: number;
    }>;
  };
  stageFailures: Array<{
    stage: ValidationStage;
    podsRan: number;
    podsFailed: number;
    failureRate: number;
  }>;
  profileHeatmap: Array<{
    profile: string;
    stages: Array<{
      stage: ValidationStage;
      podsRan: number;
      podsFailed: number;
      failureRate: number;
    }>;
  }>;
  summary: {
    topFailureStage: ValidationStage | '';
    avgReworkCount: number;
    totalPodsInWindow: number;
  };
}

// ── Constants ─────────────────────────────────────────────────────────────────

const BANDS: FunnelBand[] = [
  'queued',
  'provisioning',
  'running',
  'validating',
  'validated',
  'approved',
  'merging',
  'complete',
];

const BAND_INDEX: Record<FunnelBand, number> = Object.fromEntries(
  BANDS.map((b, i) => [b, i] as const),
) as Record<FunnelBand, number>;

function isFunnelBand(s: string): s is FunnelBand {
  return s in BAND_INDEX;
}

const STAGES: ValidationStage[] = [
  'build',
  'health',
  'smoke',
  'test',
  'lint',
  'sast',
  'facts',
  'taskReview',
];

function emptyStageSets(): Record<ValidationStage, Set<string>> {
  return Object.fromEntries(STAGES.map((s) => [s, new Set<string>()])) as Record<
    ValidationStage,
    Set<string>
  >;
}

function emptyProfileStageMap(): Record<ValidationStage, StageAccum> {
  return Object.fromEntries(
    STAGES.map((s) => [s, { ran: new Set<string>(), failed: new Set<string>() }]),
  ) as Record<ValidationStage, StageAccum>;
}

// ── Internal types ────────────────────────────────────────────────────────────

interface CohortRow {
  id: string;
  profileName: string;
  status: string;
  completedAt: string;
  reworkCount: number;
  firstValidation: string | null;
  historyArchived: number;
}

interface DropGroup {
  from: FunnelBand;
  to: FinalStatus;
  pods: CohortRow[];
}

type StageAccum = { ran: Set<string>; failed: Set<string> };

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Terminal cohort WHERE clause — mirrors Phase 1's cost-aggregation filter verbatim.
 * Reuse the literal clause; do not import from Phase 1 (that shape is frozen).
 */
function terminalCohortWhere(): string {
  return `output_mode != 'workspace'
    AND status IN ('complete', 'killed', 'failed')
    AND completed_at >= datetime('now', '-' || @days || ' days')`;
}

/** Generate the list of calendar dates for the sparkline (UTC, YYYY-MM-DD).
 *  The last entry is today; the first entry is (days-1) days ago. */
function sparklineDays(days: number): string[] {
  const nowMs = Date.now();
  return Array.from({ length: days }, (_, i) =>
    new Date(nowMs - (days - 1 - i) * 86_400_000).toISOString().slice(0, 10),
  );
}

function roundRate(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}

// ── Empty-cohort fast path ────────────────────────────────────────────────────

function emptyResponse(days: number): ReliabilityAnalyticsResponse {
  return {
    firstPassRate: 0,
    firstPassRateSparkline: sparklineDays(days).map((day) => ({ day, rate: 0 })),
    firstPassRateDelta: { value: 0, direction: 'flat' },
    funnel: {
      bands: BANDS.map((band) => ({ band, count: 0 })),
      drops: [],
    },
    stageFailures: STAGES.map((stage) => ({
      stage,
      podsRan: 0,
      podsFailed: 0,
      failureRate: 0,
    })),
    profileHeatmap: [],
    summary: { topFailureStage: '', avgReworkCount: 0, totalPodsInWindow: 0 },
  };
}

// ── Main export ───────────────────────────────────────────────────────────────

export function computeReliabilityAnalytics(
  db: Database.Database,
  days: number,
): ReliabilityAnalyticsResponse {
  // Terminal cohort: worker pods that reached a final status within the trailing window.
  const cohort = db
    .prepare(
      `SELECT id, history_archived AS historyArchived,
              profile_name  AS profileName,
              status,
              completed_at  AS completedAt,
              rework_count  AS reworkCount,
              (SELECT result FROM retained_validations v WHERE v.pod_id = p.id
               ORDER BY v.sequence, v.created_at, v.id LIMIT 1) AS firstValidation
       FROM retained_pods p
       WHERE ${terminalCohortWhere()}`,
    )
    .all({ days }) as CohortRow[];

  const totalPodsInWindow = cohort.length;
  if (totalPodsInWindow === 0) return emptyResponse(days);

  // Earliest durable sequence, never a later successful retry or a waived latest result.
  const firstPassCount = cohort.filter(
    (p) => p.status === 'complete' && p.reworkCount === 0 && isExecutedFirstPass(p.firstValidation),
  ).length;
  const firstPassRate = firstPassCount / totalPodsInWindow;

  // Sparkline: computed from in-memory cohort to avoid a second table scan.
  // completedAt is stored as ISO-8601 UTC, so the first 10 chars give the date.
  const dayBuckets = new Map<string, { firstPass: number; total: number }>();
  for (const pod of cohort) {
    const day = pod.completedAt.slice(0, 10);
    const bucket = dayBuckets.get(day) ?? { firstPass: 0, total: 0 };
    bucket.total++;
    if (
      pod.status === 'complete' &&
      pod.reworkCount === 0 &&
      isExecutedFirstPass(pod.firstValidation)
    )
      bucket.firstPass++;
    dayBuckets.set(day, bucket);
  }
  const firstPassRateSparkline = sparklineDays(days).map((day) => {
    const b = dayBuckets.get(day);
    return { day, rate: b && b.total > 0 ? b.firstPass / b.total : 0 };
  });

  // Prior-window delta: the period immediately before the current window.
  const prior = db
    .prepare(
      `SELECT status, rework_count AS reworkCount,
              (SELECT result FROM retained_validations v WHERE v.pod_id = p.id
               ORDER BY v.sequence, v.created_at, v.id LIMIT 1) AS firstValidation
       FROM retained_pods p
       WHERE output_mode != 'workspace'
         AND status IN ('complete', 'killed', 'failed')
         AND completed_at >= datetime('now', '-' || @priorDays || ' days')
         AND completed_at <  datetime('now', '-' || @days    || ' days')`,
    )
    .all({ priorDays: days * 2, days }) as CohortRow[];

  const priorRate =
    prior.length > 0
      ? prior.filter(
          (p) =>
            p.status === 'complete' &&
            p.reworkCount === 0 &&
            isExecutedFirstPass(p.firstValidation),
        ).length / prior.length
      : 0;
  const deltaValue = (firstPassRate - priorRate) * 100;
  const deltaDirection: 'up' | 'down' | 'flat' =
    deltaValue > 0.5 ? 'up' : deltaValue < -0.5 ? 'down' : 'flat';

  // Funnel: derive per-pod band sets from status-change events.
  // Use a subquery instead of an IN-clause with spread params to avoid hitting
  // SQLite's SQLITE_MAX_VARIABLE_NUMBER limit on large cohorts.
  const eventRows = db
    .prepare(
      `SELECT pod_id AS podId,
              CASE WHEN json_valid(payload) THEN json_extract(payload, '$.newStatus') END AS newStatus
       FROM retained_events
       WHERE type = 'pod.status_changed'
         AND pod_id IN (SELECT id FROM retained_pods WHERE ${terminalCohortWhere()})`,
    )
    .all({ days }) as Array<{ podId: string; newStatus: string | null }>;

  // Deduplicated set of happy-path bands reached per pod.
  const podBands = new Map<string, Set<FunnelBand>>();
  for (const row of eventRows) {
    if (!row.newStatus || !isFunnelBand(row.newStatus)) continue;
    let bandSet = podBands.get(row.podId);
    if (!bandSet) {
      bandSet = new Set();
      podBands.set(row.podId, bandSet);
    }
    bandSet.add(row.newStatus);
  }

  const bandCounts: Record<FunnelBand, number> = Object.fromEntries(
    BANDS.map((b) => [b, 0]),
  ) as Record<FunnelBand, number>;
  const dropMap = new Map<string, DropGroup>();

  for (const pod of cohort) {
    const bandSet = podBands.get(pod.id);
    // Pre-event-bus pods with no status-change events: excluded from funnel drops.
    if (!bandSet || bandSet.size === 0) continue;

    // Track the last band reached as we iterate, so we don't need a second lookup.
    let lastBand: FunnelBand | null = null;
    let maxIdx = -1;
    for (const b of bandSet) {
      bandCounts[b] += 1;
      const idx = BAND_INDEX[b];
      if (idx > maxIdx) {
        maxIdx = idx;
        lastBand = b;
      }
    }

    if (pod.status === 'complete' || lastBand === null) continue;

    const finalStatus = pod.status as FinalStatus;
    const key = `${lastBand}|${finalStatus}`;
    let group = dropMap.get(key);
    if (!group) {
      group = { from: lastBand, to: finalStatus, pods: [] };
      dropMap.set(key, group);
    }
    group.pods.push(pod);
  }

  const bands = BANDS.map((band) => ({ band, count: bandCounts[band] }));

  const drops = [...dropMap.values()].map((group) => {
    const sorted = [...group.pods].sort((a, b) => b.completedAt.localeCompare(a.completedAt));
    return {
      from: group.from,
      to: group.to,
      count: group.pods.length,
      topPods: sorted.slice(0, 10).map((p) => ({
        podId: p.id,
        ...(p.historyArchived === 1 ? { historyArchived: true } : {}),
        profile: p.profileName,
        finalStatus: p.status as FinalStatus,
        completedAt: p.completedAt,
      })),
      overflow: Math.max(0, group.pods.length - 10),
    };
  });

  // Stage failures: walk validation rows; use Sets for ever-failed semantics across attempts.
  // Same subquery pattern as events to avoid SQLITE_MAX_VARIABLE_NUMBER on large cohorts.
  const validationRows = db
    .prepare(
      `SELECT pod_id AS podId, result
       FROM retained_validations
       WHERE pod_id IN (SELECT id FROM retained_pods WHERE ${terminalCohortWhere()})`,
    )
    .all({ days }) as Array<{ podId: string; result: string }>;

  const podValidations = new Map<string, unknown[]>();
  for (const row of validationRows) {
    try {
      const parsed = JSON.parse(row.result) as unknown;
      let list = podValidations.get(row.podId);
      if (!list) {
        list = [];
        podValidations.set(row.podId, list);
      }
      list.push(parsed);
    } catch {
      // skip malformed validation JSON
    }
  }

  const stageRan = emptyStageSets();
  const stageFailed = emptyStageSets();
  const profileData = new Map<string, Record<ValidationStage, StageAccum>>();

  for (const pod of cohort) {
    const profile = pod.profileName;
    let pMap = profileData.get(profile);
    if (!pMap) {
      pMap = emptyProfileStageMap();
      profileData.set(profile, pMap);
    }

    for (const vr of podValidations.get(pod.id) ?? []) {
      for (const { stage, executed, failed } of validationCoverage(vr)) {
        if (executed) {
          stageRan[stage].add(pod.id);
          pMap[stage].ran.add(pod.id);
        }
        if (failed) {
          stageFailed[stage].add(pod.id);
          pMap[stage].failed.add(pod.id);
        }
      }
    }
  }

  const stageFailures = STAGES.map((stage) => {
    const podsRan = stageRan[stage].size;
    const podsFailed = stageFailed[stage].size;
    return {
      stage,
      podsRan,
      podsFailed,
      failureRate: podsRan > 0 ? roundRate(podsFailed / podsRan) : 0,
    };
  });

  const profileHeatmap = [...profileData.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([profile, stageMap]) => ({
      profile,
      stages: STAGES.filter((s) => stageMap[s].ran.size > 0).map((s) => {
        const { ran, failed } = stageMap[s];
        const podsRan = ran.size;
        const podsFailed = failed.size;
        return {
          stage: s,
          podsRan,
          podsFailed,
          failureRate: podsRan > 0 ? roundRate(podsFailed / podsRan) : 0,
        };
      }),
    }));

  const topFailureStage = findTopFailureStage(stageFailures);
  const avgReworkCount = cohort.reduce((s, p) => s + p.reworkCount, 0) / totalPodsInWindow;

  return {
    firstPassRate,
    firstPassRateSparkline,
    firstPassRateDelta: { value: deltaValue, direction: deltaDirection },
    funnel: { bands, drops },
    stageFailures,
    profileHeatmap,
    summary: { topFailureStage, avgReworkCount, totalPodsInWindow },
  };
}

// ── Summary helpers ───────────────────────────────────────────────────────────

function findTopFailureStage(
  stageFailures: Array<{ stage: ValidationStage; podsFailed: number; failureRate: number }>,
): ValidationStage | '' {
  const withFailures = stageFailures.filter((s) => s.podsFailed > 0);
  if (withFailures.length === 0) return '';
  const sorted = withFailures.sort((a, b) => {
    if (b.failureRate !== a.failureRate) return b.failureRate - a.failureRate;
    if (b.podsFailed !== a.podsFailed) return b.podsFailed - a.podsFailed;
    return a.stage.localeCompare(b.stage);
  });
  const top = sorted[0];
  return top ? top.stage : '';
}
