/**
 * Escalations analytics aggregator.
 * Pure function: takes a SQLite handle and a trailing window in days,
 * returns an EscalationsAnalyticsResponse. No side effects, no mutations.
 *
 * THREE COHORTS — keep them distinct; mixing them is the known footgun:
 *
 * TERMINAL cohort:
 *   output_mode != 'workspace' AND status IN ('complete','killed','failed')
 *   AND completed_at >= datetime('now', '-' || @days || ' days')
 *   Used for: summary.selfRecoveryRate denominator, humanAttentionPodCount,
 *   humanAttentionCount, askAiCount, perProfile[].
 *
 * ESCALATION_WINDOW cohort (no pod-cohort restriction):
 *   escalations.created_at >= datetime('now', '-' || @days || ' days')
 *   Used for: dailyHumanCountSparkline, askHumanTtr.buckets[], askHumanTtr.openCount,
 *   blockerPatterns[].
 *
 * ASK_HUMAN_RESOLVED (sub-set of ESCALATION_WINDOW):
 *   type='ask_human' AND created_at IN window AND resolved_at IS NOT NULL
 *   Used for: askHumanTtr histogram, resolvedCount, maxSeconds.
 *   openCount uses the same window but resolved_at IS NULL — point-in-time.
 *
 * selfRecoveryRateDelta.value is an ABSOLUTE fraction (0.05 = +5pp).
 * Desktop should format as pp, not %.
 */
import type Database from 'better-sqlite3';
import type {
  AskHumanTtr,
  AskHumanTtrBucket,
  BlockerPattern,
  EscalationsAnalyticsResponse,
  EscalationsSummary,
  PerProfileEscalation,
} from '@autopod/shared';

// ── Constants ─────────────────────────────────────────────────────────────────

const HUMAN_ATTENTION_SQL = `('ask_human','report_blocker','validation_override','action_approval')`;

const TTR_BUCKET_LABELS = ['<1m', '1–5m', '5–15m', '15m–1h', '1–4h', '4–12h', '12–24h', '>24h'] as const;
// Right-exclusive boundaries in seconds. Index i: bucket label[i] covers [boundaries[i-1], boundaries[i]).
const TTR_BOUNDARIES = [60, 300, 900, 3600, 14400, 43200, 86400];

// ── Cohort clause helpers ──────────────────────────────────────────────────────

// keep in sync with: reliability-aggregator.ts terminalCohortWhere()
function terminalCohortWhere(): string {
  return `output_mode != 'workspace'
    AND status IN ('complete', 'killed', 'failed')
    AND completed_at >= datetime('now', '-' || @days || ' days')`;
}

// ── Math helpers ──────────────────────────────────────────────────────────────

/** Generate UTC YYYY-MM-DD date strings for the trailing window (oldest first). */
function sparklineDays(days: number): string[] {
  const nowMs = Date.now();
  return Array.from({ length: days }, (_, i) =>
    new Date(nowMs - (days - 1 - i) * 86_400_000).toISOString().slice(0, 10),
  );
}

function bucketTtrSeconds(secs: number): number {
  for (let i = 0; i < TTR_BOUNDARIES.length; i++) {
    if (secs < TTR_BOUNDARIES[i]!) return i;
  }
  return TTR_BOUNDARIES.length; // '>24h' bucket
}

// ── Empty-cohort fast path ────────────────────────────────────────────────────

function emptyResponse(days: number): EscalationsAnalyticsResponse {
  return {
    summary: {
      selfRecoveryRate: 1.0,
      cohortSize: 0,
      humanAttentionPodCount: 0,
      humanAttentionCount: 0,
      askAiCount: 0,
      dailyHumanCountSparkline: sparklineDays(days).map((day) => ({ day, count: 0 })),
      selfRecoveryRateDelta: { value: 0, direction: 'flat' },
    },
    askHumanTtr: {
      buckets: TTR_BUCKET_LABELS.map((label) => ({ label, count: 0 })),
      resolvedCount: 0,
      openCount: 0,
      maxSeconds: 0,
    },
    perProfile: [],
    blockerPatterns: [],
  };
}

// ── Main export ───────────────────────────────────────────────────────────────

export function computeEscalationsAnalytics(
  db: Database.Database,
  days: number,
): EscalationsAnalyticsResponse {
  // ── Terminal cohort ─────────────────────────────────────────────────────────
  const { cohortSize } = db
    .prepare(`SELECT COUNT(*) AS cohortSize FROM pods WHERE ${terminalCohortWhere()}`)
    .get({ days }) as { cohortSize: number };

  // ── Summary: humanAttentionPodCount, humanAttentionCount, askAiCount ────────
  // Uses sub-query to avoid SQLITE_MAX_VARIABLE_NUMBER on large cohorts.
  const escalationSummary = db
    .prepare(
      `SELECT
         COUNT(DISTINCT CASE WHEN type IN ${HUMAN_ATTENTION_SQL} THEN pod_id END) AS humanAttentionPodCount,
         COUNT(CASE WHEN type IN ${HUMAN_ATTENTION_SQL} THEN 1 END) AS humanAttentionCount,
         COUNT(CASE WHEN type = 'ask_ai' THEN 1 END) AS askAiCount
       FROM escalations
       WHERE pod_id IN (SELECT id FROM pods WHERE ${terminalCohortWhere()})`,
    )
    .get({ days }) as {
    humanAttentionPodCount: number;
    humanAttentionCount: number;
    askAiCount: number;
  };

  const humanAttentionPodCount = escalationSummary.humanAttentionPodCount;
  const selfRecoveryRate =
    cohortSize === 0 ? 1.0 : (cohortSize - humanAttentionPodCount) / cohortSize;

  // ── Daily sparkline (escalation-window cohort — no pod restriction) ─────────
  const sparklineDates = sparklineDays(days);
  const sparklineRows = db
    .prepare(
      `SELECT date(created_at) AS day, COUNT(*) AS count
       FROM escalations
       WHERE type IN ${HUMAN_ATTENTION_SQL}
         AND created_at >= datetime('now', '-' || @days || ' days')
       GROUP BY day`,
    )
    .all({ days }) as Array<{ day: string; count: number }>;
  const sparklineMap = new Map(sparklineRows.map((r) => [r.day, r.count]));
  const dailyHumanCountSparkline = sparklineDates.map((day) => ({
    day,
    count: sparklineMap.get(day) ?? 0,
  }));

  // ── Prior-window delta ──────────────────────────────────────────────────────
  // COUNT(DISTINCT p.id) is required: the LEFT JOIN to escalations duplicates
  // pod rows by escalation count, so plain COUNT(*) would over-count cohortSize
  // for any pod with >1 escalation.
  const prior = db
    .prepare(
      `SELECT
         COUNT(DISTINCT p.id) AS cohortSize,
         COUNT(DISTINCT CASE WHEN e.type IN ${HUMAN_ATTENTION_SQL} THEN e.pod_id END) AS humanAttentionPodCount
       FROM pods p
       LEFT JOIN escalations e ON e.pod_id = p.id
       WHERE p.output_mode != 'workspace'
         AND p.status IN ('complete', 'killed', 'failed')
         AND p.completed_at >= datetime('now', '-' || @priorDays || ' days')
         AND p.completed_at <  datetime('now', '-' || @days || ' days')`,
    )
    .get({ priorDays: days * 2, days }) as {
    cohortSize: number;
    humanAttentionPodCount: number;
  };

  let selfRecoveryRateDelta: EscalationsSummary['selfRecoveryRateDelta'];
  if (cohortSize === 0 || prior.cohortSize === 0) {
    selfRecoveryRateDelta = { value: 0, direction: 'flat' };
  } else {
    const priorRate = (prior.cohortSize - prior.humanAttentionPodCount) / prior.cohortSize;
    const deltaValue = selfRecoveryRate - priorRate;
    selfRecoveryRateDelta = {
      value: deltaValue,
      direction: deltaValue > 0.005 ? 'up' : deltaValue < -0.005 ? 'down' : 'flat',
    };
  }

  // ── askHumanTtr ─────────────────────────────────────────────────────────────
  // Resolved rows only — open rows are surfaced separately via openCount.
  const resolvedTtrRows = db
    .prepare(
      `SELECT (julianday(resolved_at) - julianday(created_at)) * 86400.0 AS seconds
       FROM escalations
       WHERE type = 'ask_human'
         AND created_at >= datetime('now', '-' || @days || ' days')
         AND resolved_at IS NOT NULL`,
    )
    .all({ days }) as Array<{ seconds: number }>;

  const ttrCounts = new Array<number>(TTR_BUCKET_LABELS.length).fill(0);
  let maxSeconds = 0;
  for (const row of resolvedTtrRows) {
    // Round to ms precision to absorb julianday floating-point noise.
    const secs = Math.round(row.seconds * 1000) / 1000;
    const idx = bucketTtrSeconds(secs);
    ttrCounts[idx]!++;
    if (secs > maxSeconds) maxSeconds = secs;
  }

  const openCountRow = db
    .prepare(
      `SELECT COUNT(*) AS count FROM escalations
       WHERE type = 'ask_human'
         AND created_at >= datetime('now', '-' || @days || ' days')
         AND resolved_at IS NULL`,
    )
    .get({ days }) as { count: number };

  const askHumanTtrBuckets: AskHumanTtrBucket[] = TTR_BUCKET_LABELS.map((label, i) => ({
    label,
    count: ttrCounts[i]!,
  }));
  const askHumanTtr: AskHumanTtr = {
    buckets: askHumanTtrBuckets,
    resolvedCount: resolvedTtrRows.length,
    openCount: openCountRow.count,
    maxSeconds,
  };

  // ── perProfile ──────────────────────────────────────────────────────────────
  // Uses sub-query to avoid SQLITE_MAX_VARIABLE_NUMBER on large cohorts.
  const profileRows = db
    .prepare(
      `SELECT
         p.profile_name AS profileName,
         COUNT(DISTINCT p.id) AS podCount,
         COUNT(DISTINCT CASE WHEN e.type IN ${HUMAN_ATTENTION_SQL} THEN p.id END) AS escalatedCount
       FROM pods p
       LEFT JOIN escalations e ON e.pod_id = p.id
       WHERE ${terminalCohortWhere()}
       GROUP BY p.profile_name`,
    )
    .all({ days }) as Array<{ profileName: string; podCount: number; escalatedCount: number }>;

  const largeProfiles: PerProfileEscalation[] = [];
  let smallPodCount = 0;
  let smallEscalatedCount = 0;

  for (const row of profileRows) {
    if (row.podCount < 5) {
      smallPodCount += row.podCount;
      smallEscalatedCount += row.escalatedCount;
    } else {
      largeProfiles.push({
        profile: row.profileName,
        podCount: row.podCount,
        escalatedCount: row.escalatedCount,
        rate: row.escalatedCount / row.podCount,
      });
    }
  }

  if (smallPodCount > 0) {
    largeProfiles.push({
      profile: '<small profiles>',
      podCount: smallPodCount,
      escalatedCount: smallEscalatedCount,
      rate: smallEscalatedCount / smallPodCount,
    });
  }

  largeProfiles.sort((a, b) => b.rate - a.rate || b.podCount - a.podCount);

  // ── blockerPatterns ─────────────────────────────────────────────────────────
  const patternRows = db
    .prepare(
      `SELECT
         trim(json_extract(payload, '$.description')) AS description,
         COUNT(*) AS count
       FROM escalations
       WHERE type = 'report_blocker'
         AND created_at >= datetime('now', '-' || @days || ' days')
         AND json_extract(payload, '$.description') IS NOT NULL
         AND length(trim(json_extract(payload, '$.description'))) > 0
       GROUP BY description
       ORDER BY count DESC, description ASC
       LIMIT 10`,
    )
    .all({ days }) as Array<{ description: string; count: number }>;

  const podIdsForPatternStmt = db.prepare(
    `SELECT DISTINCT pod_id AS podId
     FROM escalations
     WHERE type = 'report_blocker'
       AND trim(json_extract(payload, '$.description')) = @description
       AND created_at >= datetime('now', '-' || @days || ' days')
     ORDER BY created_at DESC
     LIMIT 10`,
  );

  const blockerPatterns: BlockerPattern[] = patternRows.map((pat) => {
    const podIdRows = podIdsForPatternStmt.all({ description: pat.description, days }) as Array<{
      podId: string;
    }>;
    return {
      description: pat.description,
      count: pat.count,
      podIds: podIdRows.map((r) => r.podId),
    };
  });

  return {
    summary: {
      selfRecoveryRate,
      cohortSize,
      humanAttentionPodCount,
      humanAttentionCount: escalationSummary.humanAttentionCount,
      askAiCount: escalationSummary.askAiCount,
      dailyHumanCountSparkline,
      selfRecoveryRateDelta,
    },
    askHumanTtr,
    perProfile: largeProfiles,
    blockerPatterns,
  };
}
