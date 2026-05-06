/**
 * Reliability funnel + stage failure analytics aggregator.
 * Pure function: takes a SQLite handle and a trailing window in days,
 * returns a ReliabilityAnalyticsResponse. No side effects, no mutations.
 */
import type Database from 'better-sqlite3';

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
  | 'acValidation'
  | 'taskReview';

export interface ReliabilityAnalyticsResponse {
  /** First-pass rate over the trailing window: 0..1. */
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

const BAND_INDEX = new Map<string, number>(BANDS.map((b, i) => [b, i]));

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

// ── Internal types ────────────────────────────────────────────────────────────

interface CohortRow {
  id: string;
  profileName: string;
  status: string;
  completedAt: string;
  reworkCount: number;
}

// Only the fields we read from stored validation JSON.
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

/** Generate the list of calendar dates for the sparkline (UTC, YYYY-MM-DD). */
function sparklineDays(days: number): string[] {
  const nowMs = Date.now();
  const windowStartMs = nowMs - days * 86_400_000;
  return Array.from({ length: days }, (_, i) =>
    new Date(windowStartMs + i * 86_400_000).toISOString().slice(0, 10),
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
      `SELECT id,
              profile_name  AS profileName,
              status,
              completed_at  AS completedAt,
              rework_count  AS reworkCount
       FROM pods
       WHERE ${terminalCohortWhere()}`,
    )
    .all({ days }) as CohortRow[];

  const totalPodsInWindow = cohort.length;
  if (totalPodsInWindow === 0) return emptyResponse(days);

  const cohortIds = cohort.map((p) => p.id);
  const placeholders = cohortIds.map(() => '?').join(', ');

  // First-pass: complete with no rework.
  const firstPassCount = cohort.filter(
    (p) => p.status === 'complete' && p.reworkCount === 0,
  ).length;
  const firstPassRate = firstPassCount / totalPodsInWindow;

  // Sparkline: computed from in-memory cohort to avoid a second table scan.
  // completedAt is stored as ISO-8601 UTC, so the first 10 chars give the date.
  const dayBuckets = new Map<string, { firstPass: number; total: number }>();
  for (const pod of cohort) {
    const day = pod.completedAt.slice(0, 10);
    const bucket = dayBuckets.get(day) ?? { firstPass: 0, total: 0 };
    bucket.total++;
    if (pod.status === 'complete' && pod.reworkCount === 0) bucket.firstPass++;
    dayBuckets.set(day, bucket);
  }
  const firstPassRateSparkline = sparklineDays(days).map((day) => {
    const b = dayBuckets.get(day);
    return { day, rate: b && b.total > 0 ? b.firstPass / b.total : 0 };
  });

  // Prior-window delta: the period immediately before the current window.
  const prior = db
    .prepare(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN status = 'complete' AND rework_count = 0 THEN 1 ELSE 0 END) AS firstPass
       FROM pods
       WHERE output_mode != 'workspace'
         AND status IN ('complete', 'killed', 'failed')
         AND completed_at >= datetime('now', '-' || @priorDays || ' days')
         AND completed_at <  datetime('now', '-' || @days    || ' days')`,
    )
    .get({ priorDays: days * 2, days }) as { total: number; firstPass: number };

  const priorRate = prior.total > 0 ? prior.firstPass / prior.total : 0;
  const deltaValue = (firstPassRate - priorRate) * 100;
  const deltaDirection: 'up' | 'down' | 'flat' =
    deltaValue > 0.5 ? 'up' : deltaValue < -0.5 ? 'down' : 'flat';

  // Funnel: derive per-pod band sets from status-change events.
  const eventRows = db
    .prepare(
      `SELECT pod_id AS podId,
              json_extract(payload, '$.newStatus') AS newStatus
       FROM events
       WHERE type = 'pod.status_changed'
         AND pod_id IN (${placeholders})`,
    )
    .all(...cohortIds) as Array<{ podId: string; newStatus: string | null }>;

  // Deduplicated set of happy-path bands reached per pod.
  const podBands = new Map<string, Set<string>>();
  for (const row of eventRows) {
    if (!row.newStatus || !BAND_INDEX.has(row.newStatus)) continue;
    if (!podBands.has(row.podId)) podBands.set(row.podId, new Set());
    podBands.get(row.podId)!.add(row.newStatus);
  }

  const bandCounts = new Map<FunnelBand, number>(BANDS.map((b) => [b, 0]));
  const dropMap = new Map<string, DropGroup>();

  for (const pod of cohort) {
    const bands = podBands.get(pod.id);
    // Pre-event-bus pods with no status-change events: excluded from funnel drops.
    if (!bands || bands.size === 0) continue;

    for (const b of bands) {
      bandCounts.set(b as FunnelBand, (bandCounts.get(b as FunnelBand) ?? 0) + 1);
    }

    // Last band reached = highest-indexed band in the pod's event set.
    let maxIdx = -1;
    for (const b of bands) {
      const idx = BAND_INDEX.get(b)!;
      if (idx > maxIdx) maxIdx = idx;
    }
    const lastBand = BANDS[maxIdx]!;

    if (pod.status === 'complete') continue;

    const finalStatus = pod.status as FinalStatus;
    const key = `${lastBand}|${finalStatus}`;
    if (!dropMap.has(key)) dropMap.set(key, { from: lastBand, to: finalStatus, pods: [] });
    dropMap.get(key)!.pods.push(pod);
  }

  const bands = BANDS.map((band) => ({ band, count: bandCounts.get(band) ?? 0 }));

  const drops = [...dropMap.values()].map((group) => {
    const sorted = [...group.pods].sort((a, b) => b.completedAt.localeCompare(a.completedAt));
    return {
      from: group.from,
      to: group.to,
      count: group.pods.length,
      topPods: sorted.slice(0, 10).map((p) => ({
        podId: p.id,
        profile: p.profileName,
        finalStatus: p.status as FinalStatus,
        completedAt: p.completedAt,
      })),
      overflow: Math.max(0, group.pods.length - 10),
    };
  });

  // Stage failures: walk validation rows; use Sets for ever-failed semantics across attempts.
  const validationRows = db
    .prepare(
      `SELECT pod_id AS podId, result
       FROM validations
       WHERE pod_id IN (${placeholders})`,
    )
    .all(...cohortIds) as Array<{ podId: string; result: string }>;

  const podValidations = new Map<string, StoredValidationResult[]>();
  for (const row of validationRows) {
    try {
      const parsed = JSON.parse(row.result) as StoredValidationResult;
      if (!podValidations.has(row.podId)) podValidations.set(row.podId, []);
      podValidations.get(row.podId)!.push(parsed);
    } catch {
      // skip malformed validation JSON
    }
  }

  const stageRan = new Map<ValidationStage, Set<string>>(STAGES.map((s) => [s, new Set()]));
  const stageFailed = new Map<ValidationStage, Set<string>>(STAGES.map((s) => [s, new Set()]));
  const profileData = new Map<string, Map<ValidationStage, StageAccum>>();

  for (const pod of cohort) {
    const profile = pod.profileName;
    if (!profileData.has(profile)) {
      profileData.set(
        profile,
        new Map(STAGES.map((s) => [s, { ran: new Set(), failed: new Set() }])),
      );
    }
    const pMap = profileData.get(profile)!;

    for (const vr of podValidations.get(pod.id) ?? []) {
      // build — reads from result.smoke.build (not a top-level field)
      if (vr.smoke?.build !== undefined) {
        stageRan.get('build')!.add(pod.id);
        pMap.get('build')!.ran.add(pod.id);
        if (vr.smoke.build.status === 'fail') {
          stageFailed.get('build')!.add(pod.id);
          pMap.get('build')!.failed.add(pod.id);
        }
      }

      // health — reads from result.smoke.health (not a top-level field)
      if (vr.smoke?.health !== undefined) {
        stageRan.get('health')!.add(pod.id);
        pMap.get('health')!.ran.add(pod.id);
        if (vr.smoke.health.status === 'fail') {
          stageFailed.get('health')!.add(pod.id);
          pMap.get('health')!.failed.add(pod.id);
        }
      }

      // smoke — failed when any page in result.smoke.pages has status 'fail'
      if (vr.smoke?.pages !== undefined) {
        stageRan.get('smoke')!.add(pod.id);
        pMap.get('smoke')!.ran.add(pod.id);
        if (vr.smoke.pages.some((pg) => pg.status === 'fail')) {
          stageFailed.get('smoke')!.add(pod.id);
          pMap.get('smoke')!.failed.add(pod.id);
        }
      }

      // test, lint, sast — optional top-level fields
      for (const stage of ['test', 'lint', 'sast'] as const) {
        const sr = vr[stage];
        if (sr !== undefined && sr !== null) {
          stageRan.get(stage)!.add(pod.id);
          pMap.get(stage)!.ran.add(pod.id);
          if (sr.status === 'fail') {
            stageFailed.get(stage)!.add(pod.id);
            pMap.get(stage)!.failed.add(pod.id);
          }
        }
      }

      if (vr.acValidation !== undefined && vr.acValidation !== null) {
        stageRan.get('acValidation')!.add(pod.id);
        pMap.get('acValidation')!.ran.add(pod.id);
        if (vr.acValidation.status === 'fail') {
          stageFailed.get('acValidation')!.add(pod.id);
          pMap.get('acValidation')!.failed.add(pod.id);
        }
      }

      if (vr.taskReview !== undefined && vr.taskReview !== null) {
        stageRan.get('taskReview')!.add(pod.id);
        pMap.get('taskReview')!.ran.add(pod.id);
        if (vr.taskReview.status === 'fail') {
          stageFailed.get('taskReview')!.add(pod.id);
          pMap.get('taskReview')!.failed.add(pod.id);
        }
      }
    }
  }

  const stageFailures = STAGES.map((stage) => {
    const podsRan = stageRan.get(stage)!.size;
    const podsFailed = stageFailed.get(stage)!.size;
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
      stages: STAGES.filter((s) => stageMap.get(s)!.ran.size > 0).map((s) => {
        const { ran, failed } = stageMap.get(s)!;
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
  return withFailures.sort((a, b) => {
    if (b.failureRate !== a.failureRate) return b.failureRate - a.failureRate;
    if (b.podsFailed !== a.podsFailed) return b.podsFailed - a.podsFailed;
    return a.stage.localeCompare(b.stage);
  })[0]!.stage;
}
