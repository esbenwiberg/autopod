/**
 * Memory effectiveness analytics.
 *
 * Pure aggregation: reads SQLite tables and returns evidence for the desktop.
 * It never mutates memory state or disables memories.
 */
import type { MemoryAnalyticsResponse } from '@autopod/shared';
import type Database from 'better-sqlite3';

interface PodMetricRow {
  podId: string;
  profileName: string;
  status: string;
  createdAt: string;
  completedAt: string;
  reworkCount: number;
  prFixAttempts: number;
  costUsd: number;
  qualityScore: number | null;
  validationPassed: number | null;
  escalationCount: number;
}

interface UsageCountRow {
  kind: string;
  count: number;
}

interface OutcomeCountRow {
  outcome: string | null;
  count: number;
}

interface TopMemoryRow {
  memoryId: string;
  path: string;
  impactSummary: string | null;
  selectedCount: number;
  injectedCount: number;
  appliedCount: number;
  harmfulStaleCount: number;
}

const EMPTY_IMPACT = {
  cohortSize: 0,
  comparisonCohortSize: 0,
  qualityDelta: null,
  validationFailureDelta: null,
  fixAttemptDelta: null,
  escalationDelta: null,
  costDeltaUsd: null,
  reworkDelta: null,
  firstPassRateDelta: null,
  throughputDelta: null,
};

function avg(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function round(value: number | null): number | null {
  if (value === null) return null;
  return Math.round(value * 10_000) / 10_000;
}

function delta(left: number | null, right: number | null): number | null {
  if (left === null || right === null) return null;
  return round(left - right);
}

function durationHours(pod: PodMetricRow): number | null {
  const started = Date.parse(pod.createdAt);
  const completed = Date.parse(pod.completedAt);
  if (!Number.isFinite(started) || !Number.isFinite(completed) || completed < started) return null;
  return (completed - started) / 3_600_000;
}

function firstPassRate(rows: PodMetricRow[]): number | null {
  if (rows.length === 0) return null;
  const firstPass = rows.filter(
    (row) => row.status === 'complete' && row.reworkCount === 0 && row.prFixAttempts === 0,
  ).length;
  return firstPass / rows.length;
}

function validationFailureRate(rows: PodMetricRow[]): number | null {
  const known = rows.filter((row) => row.validationPassed !== null);
  if (known.length === 0) return null;
  return known.filter((row) => row.validationPassed === 0).length / known.length;
}

export function computeMemoryEffectivenessAnalytics(
  db: Database.Database,
  days: number,
): MemoryAnalyticsResponse {
  const usageRows = db
    .prepare(
      `SELECT kind, COUNT(*) AS count
       FROM memory_usage_events
       WHERE created_at >= datetime('now', '-' || @days || ' days')
       GROUP BY kind`,
    )
    .all({ days }) as UsageCountRow[];

  const outcomeRows = db
    .prepare(
      `SELECT outcome, COUNT(*) AS count
       FROM memory_usage_events
       WHERE created_at >= datetime('now', '-' || @days || ' days')
         AND outcome IS NOT NULL
       GROUP BY outcome`,
    )
    .all({ days }) as OutcomeCountRow[];

  const countByKind = new Map(usageRows.map((row) => [row.kind, row.count]));
  const countByOutcome = new Map(outcomeRows.map((row) => [row.outcome, row.count]));

  const candidateCounts = db
    .prepare(
      `SELECT
         COUNT(*) AS candidateCount,
         SUM(CASE WHEN status = 'approved' THEN 1 ELSE 0 END) AS approvedCandidateCount
       FROM memory_candidates
       WHERE created_at >= datetime('now', '-' || @days || ' days')`,
    )
    .get({ days }) as { candidateCount: number; approvedCandidateCount: number | null };

  const topMemories = db
    .prepare(
      `SELECT
         m.id AS memoryId,
         m.path AS path,
         m.impact_summary AS impactSummary,
         SUM(CASE WHEN u.kind = 'selected' THEN 1 ELSE 0 END) AS selectedCount,
         SUM(CASE WHEN u.kind = 'injected' THEN 1 ELSE 0 END) AS injectedCount,
         SUM(CASE WHEN u.outcome = 'applied' THEN 1 ELSE 0 END) AS appliedCount,
         SUM(CASE WHEN u.outcome = 'harmful_stale' THEN 1 ELSE 0 END) AS harmfulStaleCount
       FROM memory_entries m
       JOIN memory_usage_events u ON u.memory_id = m.id
       WHERE u.created_at >= datetime('now', '-' || @days || ' days')
       GROUP BY m.id
       ORDER BY selectedCount DESC, injectedCount DESC, appliedCount DESC, m.path ASC
       LIMIT 10`,
    )
    .all({ days }) as TopMemoryRow[];

  const cohortRows = db
    .prepare(
      `WITH terminal_pods AS (
         SELECT p.id,
                p.profile_name,
                p.status,
                p.created_at,
                p.completed_at,
                p.rework_count,
                p.pr_fix_attempts,
                p.cost_usd,
                q.score AS quality_score,
                q.validation_passed,
                COUNT(e.id) AS escalation_count
         FROM pods p
         LEFT JOIN pod_quality_scores q ON q.pod_id = p.id
         LEFT JOIN escalations e ON e.pod_id = p.id
         WHERE p.output_mode != 'workspace'
           AND p.status IN ('complete', 'killed', 'failed')
           AND p.completed_at >= datetime('now', '-' || @days || ' days')
         GROUP BY p.id
       )
       SELECT id AS podId,
              profile_name AS profileName,
              status,
              created_at AS createdAt,
              completed_at AS completedAt,
              rework_count AS reworkCount,
              pr_fix_attempts AS prFixAttempts,
              cost_usd AS costUsd,
              quality_score AS qualityScore,
              validation_passed AS validationPassed,
              escalation_count AS escalationCount
       FROM terminal_pods`,
    )
    .all({ days }) as PodMetricRow[];

  const memoryPodIds = new Set(
    (
      db
        .prepare(
          `SELECT DISTINCT pod_id AS podId
           FROM memory_usage_events
           WHERE kind IN ('selected', 'injected')
             AND created_at >= datetime('now', '-' || @days || ' days')`,
        )
        .all({ days }) as Array<{ podId: string }>
    ).map((row) => row.podId),
  );

  const withMemory = cohortRows.filter((row) => memoryPodIds.has(row.podId));
  const memoryProfiles = new Set(withMemory.map((row) => row.profileName));
  const withoutMemory = cohortRows.filter(
    (row) => !memoryPodIds.has(row.podId) && memoryProfiles.has(row.profileName),
  );
  const withQuality = avg(
    withMemory.flatMap((row) => (row.qualityScore === null ? [] : [row.qualityScore])),
  );
  const withoutQuality = avg(
    withoutMemory.flatMap((row) => (row.qualityScore === null ? [] : [row.qualityScore])),
  );
  const withValidationFailures = validationFailureRate(withMemory);
  const withoutValidationFailures = validationFailureRate(withoutMemory);
  const withFirstPass = firstPassRate(withMemory);
  const withoutFirstPass = firstPassRate(withoutMemory);
  const withDuration = avg(
    withMemory.flatMap((row) => {
      const hours = durationHours(row);
      return hours === null ? [] : [hours];
    }),
  );
  const withoutDuration = avg(
    withoutMemory.flatMap((row) => {
      const hours = durationHours(row);
      return hours === null ? [] : [hours];
    }),
  );

  const impact =
    withMemory.length === 0 || withoutMemory.length === 0
      ? EMPTY_IMPACT
      : {
          cohortSize: withMemory.length,
          comparisonCohortSize: withoutMemory.length,
          qualityDelta: delta(withQuality, withoutQuality),
          validationFailureDelta: delta(withValidationFailures, withoutValidationFailures),
          fixAttemptDelta: delta(
            avg(withMemory.map((row) => row.prFixAttempts)),
            avg(withoutMemory.map((row) => row.prFixAttempts)),
          ),
          escalationDelta: delta(
            avg(withMemory.map((row) => row.escalationCount)),
            avg(withoutMemory.map((row) => row.escalationCount)),
          ),
          costDeltaUsd: delta(
            avg(withMemory.map((row) => row.costUsd)),
            avg(withoutMemory.map((row) => row.costUsd)),
          ),
          reworkDelta: delta(
            avg(withMemory.map((row) => row.reworkCount)),
            avg(withoutMemory.map((row) => row.reworkCount)),
          ),
          firstPassRateDelta: delta(withFirstPass, withoutFirstPass),
          throughputDelta: delta(withDuration, withoutDuration),
        };

  return {
    days,
    summary: {
      selectedCount: countByKind.get('selected') ?? 0,
      injectedCount: countByKind.get('injected') ?? 0,
      readCount: countByKind.get('read') ?? 0,
      searchedCount: countByKind.get('searched') ?? 0,
      appliedCount: countByOutcome.get('applied') ?? 0,
      notApplicableCount: countByOutcome.get('not_applicable') ?? 0,
      harmfulStaleCount: countByOutcome.get('harmful_stale') ?? 0,
      notReportedCount: countByKind.get('not_reported') ?? 0,
      candidateCount: candidateCounts.candidateCount,
      approvedCandidateCount: candidateCounts.approvedCandidateCount ?? 0,
    },
    impact,
    topMemories,
  };
}
