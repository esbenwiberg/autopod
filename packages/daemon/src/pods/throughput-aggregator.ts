import type {
  LoadBearingStatus,
  QueueDepthBucket,
  ThroughputAnalyticsResponse,
  TimeInStatusBox,
} from '@autopod/shared';
/**
 * Throughput analytics aggregator.
 * Pure function: takes a SQLite handle and a trailing window in days,
 * returns a ThroughputAnalyticsResponse. No side effects, no mutations.
 *
 * Two cohorts — keep them distinct; mixing them is the known footgun:
 *
 * TERMINAL cohort:
 *   output_mode != 'workspace' AND status IN ('complete','killed','failed')
 *   AND completed_at >= datetime('now', '-' || @days || ' days')
 *   Used for: summary (podsPerDay, sparkline, delta, mttmSeconds), cohort[],
 *   timeInStatus[].
 *
 * QUEUE_INTERSECT cohort (queueDepth[] ONLY):
 *   output_mode != 'workspace'
 *   AND created_at < datetime('now')
 *   AND (started_at IS NULL OR started_at >= datetime('now', '-' || @days || ' days'))
 *   A pod contributes to queue depth during [created_at, started_at) (or
 *   [created_at, now) for never-started pods). Cohort = any pod whose
 *   interval intersects [window_start, window_end].
 */
import type Database from 'better-sqlite3';

// ── Constants ─────────────────────────────────────────────────────────────────

const COHORT_CAP = 5_000;

const LOAD_BEARING_STATES: LoadBearingStatus[] = [
  'queued',
  'running',
  'validating',
  'awaiting_input',
];
const LOAD_BEARING_SET = new Set<string>(LOAD_BEARING_STATES);

// ── Cohort clause helpers ─────────────────────────────────────────────────────

// keep in sync with: reliability-aggregator.ts terminalCohortWhere()
function terminalCohortWhere(): string {
  return `output_mode != 'workspace'
    AND status IN ('complete', 'killed', 'failed')
    AND completed_at >= datetime('now', '-' || @days || ' days')`;
}

// Queue-intersect cohort used ONLY for queueDepth[]. Do not use for terminal sections.
// datetime() wrappers normalise ISO-format stored strings ('...T..Z') to SQLite format
// ('... ') so that same-day timestamp comparisons with datetime('now') work correctly.
function queueIntersectWhere(): string {
  return `output_mode != 'workspace'
    AND datetime(created_at) < datetime('now')
    AND (started_at IS NULL OR datetime(started_at) >= datetime('now', '-' || @days || ' days'))`;
}

// ── Internal types ────────────────────────────────────────────────────────────

interface CohortRow {
  id: string;
  profileName: string;
  status: string;
  completedAt: string;
  createdAt: string;
}

interface StatusEventRow {
  podId: string;
  newStatus: string | null;
  createdAt: string;
}

interface QueuePodRow {
  createdAt: string;
  startedAt: string | null;
}

// ── Math helpers ──────────────────────────────────────────────────────────────

/** Generate UTC YYYY-MM-DD date strings for the trailing window (oldest first). */
function sparklineDays(days: number): string[] {
  const nowMs = Date.now();
  return Array.from({ length: days }, (_, i) =>
    new Date(nowMs - (days - 1 - i) * 86_400_000).toISOString().slice(0, 10),
  );
}

/** Linear-interpolation percentile over a sorted array.
 *  No PERCENTILE_CONT in SQLite 3.45 WAL mode — computed in JS. */
function computePercentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  const loValue = sorted[lo] ?? 0;
  if (lo === hi) return loValue;
  const hiValue = sorted[hi] ?? loValue;
  return loValue + (idx - lo) * (hiValue - loValue);
}

// ── Queue-depth computation ───────────────────────────────────────────────────

function computeQueueDepth(pods: QueuePodRow[], days: number): QueueDepthBucket[] {
  const nowMs = Date.now();
  const windowStartMs = nowMs - days * 86_400_000;
  const windowStartHourMs = Math.floor(windowStartMs / 3_600_000) * 3_600_000;

  // Convert pod timestamps to ms once to avoid repeated Date parsing per sample.
  const podTimes = pods.map((p) => ({
    createdAtMs: new Date(p.createdAt).getTime(),
    startedAtMs: p.startedAt ? new Date(p.startedAt).getTime() : null,
  }));

  const buckets: QueueDepthBucket[] = [];

  for (let i = 0; i < days * 24; i++) {
    const hourStartMs = windowStartHourMs + i * 3_600_000;
    const hour = `${new Date(hourStartMs).toISOString().slice(0, 19)}Z`;

    let maxDepth = 0;
    let totalDepth = 0;

    // Sample at 60 minute boundaries within the hour.
    for (let m = 0; m < 60; m++) {
      const tMs = hourStartMs + m * 60_000;
      let depth = 0;
      for (const pod of podTimes) {
        if (pod.createdAtMs <= tMs && (pod.startedAtMs === null || pod.startedAtMs > tMs)) {
          depth++;
        }
      }
      if (depth > maxDepth) maxDepth = depth;
      totalDepth += depth;
    }

    buckets.push({ hour, max: maxDepth, mean: totalDepth / 60 });
  }

  return buckets;
}

// ── Time-in-status computation ────────────────────────────────────────────────

function computeTimeInStatus(cohortRows: CohortRow[], events: StatusEventRow[]): TimeInStatusBox[] {
  const podCompletedAt = new Map<string, number>();
  for (const pod of cohortRows) {
    podCompletedAt.set(pod.id, new Date(pod.completedAt).getTime());
  }

  // Events are already sorted by (pod_id, created_at) from the SQL query.
  const podEvents = new Map<string, StatusEventRow[]>();
  for (const event of events) {
    let list = podEvents.get(event.podId);
    if (!list) {
      list = [];
      podEvents.set(event.podId, list);
    }
    list.push(event);
  }

  const stateDurations = new Map<LoadBearingStatus, number[]>(
    LOAD_BEARING_STATES.map((s) => [s, []]),
  );

  for (const [podId, evts] of podEvents) {
    const completedAtMs = podCompletedAt.get(podId);
    if (completedAtMs === undefined) continue;

    for (let i = 0; i < evts.length; i++) {
      const event = evts[i];
      if (!event) continue;
      if (!event.newStatus || !LOAD_BEARING_SET.has(event.newStatus)) continue;

      const status = event.newStatus as LoadBearingStatus;
      const thisMs = new Date(event.createdAt).getTime();
      const nextMs =
        i < evts.length - 1 ? new Date(evts[i + 1]?.createdAt).getTime() : completedAtMs;
      const durationSeconds = (nextMs - thisMs) / 1000;
      stateDurations.get(status)?.push(durationSeconds);
    }
  }

  return LOAD_BEARING_STATES.map((status) => {
    const samples = stateDurations.get(status)?.sort((a, b) => a - b);
    if (samples.length === 0) {
      return { status, p25: 0, p50: 0, p75: 0, p90: 0, max: 0, sampleCount: 0 };
    }
    return {
      status,
      p25: computePercentile(samples, 25),
      p50: computePercentile(samples, 50),
      p75: computePercentile(samples, 75),
      p90: computePercentile(samples, 90),
      max: samples[samples.length - 1] ?? 0,
      sampleCount: samples.length,
    };
  });
}

// ── Main export ───────────────────────────────────────────────────────────────

export function computeThroughputAnalytics(
  db: Database.Database,
  days: number,
): ThroughputAnalyticsResponse {
  // ── Terminal cohort ───────────────────────────────────────────────────────
  // Used for: podsPerDay, sparkline, delta, mttmSeconds, cohort[], timeInStatus[].
  const cohortRows = db
    .prepare(
      `SELECT id,
              profile_name  AS profileName,
              status,
              completed_at  AS completedAt,
              created_at    AS createdAt
       FROM pods
       WHERE ${terminalCohortWhere()}
       ORDER BY completed_at DESC`,
    )
    .all({ days }) as CohortRow[];

  // ── Summary: podsPerDay, sparkline, MTTM ────────────────────────────────
  const podsPerDay = cohortRows.length / days;

  const dayBuckets = new Map<string, number>();
  let mttmTotalMs = 0;
  let mttmCount = 0;
  for (const pod of cohortRows) {
    const day = pod.completedAt.slice(0, 10);
    dayBuckets.set(day, (dayBuckets.get(day) ?? 0) + 1);
    if (pod.status === 'complete') {
      mttmTotalMs += new Date(pod.completedAt).getTime() - new Date(pod.createdAt).getTime();
      mttmCount++;
    }
  }
  const podsPerDaySparkline = sparklineDays(days).map((day) => ({
    day,
    count: dayBuckets.get(day) ?? 0,
  }));
  const mttmSeconds = mttmCount > 0 ? mttmTotalMs / mttmCount / 1000 : 0;

  // ── Summary: prior-window delta ───────────────────────────────────────────
  // Mirror of reliability-aggregator.ts:248-263 — prior window immediately before current.
  const priorRow = db
    .prepare(
      `SELECT COUNT(*) AS count
       FROM pods
       WHERE output_mode != 'workspace'
         AND status IN ('complete', 'killed', 'failed')
         AND completed_at >= datetime('now', '-' || @priorDays || ' days')
         AND completed_at <  datetime('now', '-' || @days    || ' days')`,
    )
    .get({ priorDays: days * 2, days }) as { count: number };

  const priorPerDay = priorRow.count / days;
  const deltaValue = podsPerDay - priorPerDay;
  const deltaDirection: 'up' | 'down' | 'flat' =
    deltaValue > 0.1 ? 'up' : deltaValue < -0.1 ? 'down' : 'flat';

  // ── Summary: backlog (live, window-independent) ───────────────────────────
  const backlogRow = db
    .prepare(`SELECT COUNT(*) AS count FROM pods WHERE status IN ('queued', 'provisioning')`)
    .get() as { count: number };

  // ── Cohort (capped at COHORT_CAP, already ordered DESC by completed_at) ──
  const cohortTruncated = cohortRows.length > COHORT_CAP;
  const cohortSlice = cohortTruncated ? cohortRows.slice(0, COHORT_CAP) : cohortRows;
  const cohort = cohortSlice.map((p) => ({
    podId: p.id,
    profile: p.profileName,
    status: p.status as 'complete' | 'killed' | 'failed',
    completedAt: p.completedAt,
  }));

  // ── Queue depth (QUEUE_INTERSECT cohort — NOT terminal) ───────────────────
  const queuePods = db
    .prepare(
      `SELECT created_at AS createdAt, started_at AS startedAt
       FROM pods
       WHERE ${queueIntersectWhere()}`,
    )
    .all({ days }) as QueuePodRow[];

  const queueDepth = computeQueueDepth(queuePods, days);

  // ── Time-in-status (terminal cohort; events via sub-query to avoid
  //    SQLITE_MAX_VARIABLE_NUMBER on large cohorts) ─────────────────────────
  const statusEvents = db
    .prepare(
      `SELECT pod_id    AS podId,
              json_extract(payload, '$.newStatus') AS newStatus,
              created_at AS createdAt
       FROM events
       WHERE type = 'pod.status_changed'
         AND pod_id IN (SELECT id FROM pods WHERE ${terminalCohortWhere()})
       ORDER BY pod_id, created_at`,
    )
    .all({ days }) as StatusEventRow[];

  const timeInStatus = computeTimeInStatus(cohortRows, statusEvents);

  return {
    summary: {
      podsPerDay,
      podsPerDaySparkline,
      podsPerDayDelta: { value: deltaValue, direction: deltaDirection },
      mttmSeconds,
      backlog: backlogRow.count,
    },
    cohort,
    cohortTruncated,
    queueDepth,
    timeInStatus,
  };
}
