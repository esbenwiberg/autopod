import type {
  PodQualityScore,
  QualityAnalyticsResponse,
  QualityTrend,
  RuntimeType,
} from '@autopod/shared';
import type Database from 'better-sqlite3';

export interface QualityScoreFilters {
  runtime?: RuntimeType;
  model?: string;
  profileName?: string;
  /** ISO timestamp (inclusive lower bound on `computed_at`). */
  since?: string;
  /** Max rows to return. Defaults to 200. */
  limit?: number;
}

export interface QualityScoreRepository {
  insert(score: PodQualityScore): void;
  get(podId: string): PodQualityScore | null;
  list(filters?: QualityScoreFilters): PodQualityScore[];
  listStale(limit: number, afterPodId?: string): PodQualityScore[];
  getTrends(days?: number): QualityTrend[];
  getQualityAnalytics(days: number): QualityAnalyticsResponse;
}

export const QUALITY_SCORE_ALGORITHM_VERSION = 2;

const ATTEMPT_COMPATIBILITY_PROJECTION = `
  SELECT q.pod_id,
         CASE WHEN q.algorithm_version = 2 THEN q.score_v2 ELSE q.score END AS score,
         q.algorithm_version,
         q.inspection_availability,
         CASE WHEN q.algorithm_version = 2 THEN q.read_count_v2 ELSE q.read_count END AS read_count,
         q.edit_count,
         CASE WHEN q.algorithm_version = 2
           THEN q.read_edit_ratio_v2 ELSE q.read_edit_ratio END AS read_edit_ratio,
         CASE WHEN q.algorithm_version = 2
           THEN q.edits_without_prior_read_v2
           ELSE q.edits_without_prior_read END AS edits_without_prior_read,
         q.user_interrupts,
         q.tells_count,
         q.profile_name,
         q.final_status,
         q.completed_at,
         q.computed_at,
         q.edit_churn_count,
         q.pr_fix_attempts,
         q.validation_passed,
         COALESCE((
           SELECT a.runtime FROM provider_attempts a
           WHERE a.pod_id = q.pod_id
           ORDER BY a.ordinal DESC LIMIT 1
         ), q.runtime) AS runtime,
         COALESCE((
           SELECT a.model FROM provider_attempts a
           WHERE a.pod_id = q.pod_id
           ORDER BY a.ordinal DESC LIMIT 1
         ), q.model) AS model,
         CASE WHEN EXISTS (
           SELECT 1 FROM provider_attempts a WHERE a.pod_id = q.pod_id
         ) THEN (
           SELECT COALESCE(SUM(a.input_tokens), 0)
           FROM provider_attempts a WHERE a.pod_id = q.pod_id
         ) ELSE q.input_tokens END AS input_tokens,
         CASE WHEN EXISTS (
           SELECT 1 FROM provider_attempts a WHERE a.pod_id = q.pod_id
         ) THEN (
           SELECT COALESCE(SUM(a.output_tokens), 0)
           FROM provider_attempts a WHERE a.pod_id = q.pod_id
         ) ELSE q.output_tokens END AS output_tokens,
         CASE WHEN EXISTS (
           SELECT 1 FROM provider_attempts a WHERE a.pod_id = q.pod_id
         ) THEN (
           SELECT COALESCE(SUM(a.cost_usd), 0)
           FROM provider_attempts a WHERE a.pod_id = q.pod_id
         ) ELSE q.cost_usd END AS cost_usd
  FROM pod_quality_scores q`;

function rowToScore(row: Record<string, unknown>): PodQualityScore {
  const inspectionAvailability = row.inspection_availability as 'available' | 'unavailable';
  const available = inspectionAvailability === 'available';
  return {
    podId: row.pod_id as string,
    score: available ? (row.score as number) : null,
    algorithmVersion: row.algorithm_version as number,
    inspectionAvailability,
    readCount: available ? (row.read_count as number) : null,
    editCount: row.edit_count as number,
    readEditRatio: available ? (row.read_edit_ratio as number) : null,
    editsWithoutPriorRead: available ? (row.edits_without_prior_read as number) : null,
    userInterrupts: row.user_interrupts as number,
    editChurnCount: (row.edit_churn_count as number | undefined) ?? 0,
    tellsCount: row.tells_count as number,
    prFixAttempts: (row.pr_fix_attempts as number | undefined) ?? 0,
    validationPassed:
      row.validation_passed === null || row.validation_passed === undefined
        ? null
        : (row.validation_passed as number) === 1,
    inputTokens: row.input_tokens as number,
    outputTokens: row.output_tokens as number,
    costUsd: row.cost_usd as number,
    runtime: row.runtime as RuntimeType,
    profileName: row.profile_name as string,
    model: (row.model as string | null) ?? null,
    finalStatus: row.final_status as 'complete' | 'killed',
    completedAt: row.completed_at as string,
    computedAt: row.computed_at as string,
  };
}

function rowToTrend(row: Record<string, unknown>): QualityTrend {
  return {
    day: row.day as string,
    avgScore: row.avg_score as number,
    podCount: row.pod_count as number,
    runtime: row.runtime as string,
    model: (row.model as string | null) ?? null,
  };
}

export function createQualityScoreRepository(db: Database.Database): QualityScoreRepository {
  return {
    insert(score: PodQualityScore): void {
      // ON CONFLICT REPLACE — re-running a pod (fix-pod flow) should overwrite
      // its prior score, not raise a unique-constraint error.
      db.prepare(
        `INSERT INTO pod_quality_scores (
          pod_id, score, score_v2, algorithm_version, inspection_availability,
          read_count, edit_count, read_edit_ratio,
          edits_without_prior_read, read_count_v2, read_edit_ratio_v2,
          edits_without_prior_read_v2, user_interrupts, edit_churn_count,
          tells_count, pr_fix_attempts, validation_passed,
          input_tokens, output_tokens, cost_usd,
          runtime, profile_name, model, final_status, completed_at, computed_at
        ) VALUES (
          @podId, @legacyScore, @score, @algorithmVersion, @inspectionAvailability,
          @readCount, @editCount, @readEditRatio,
          @editsWithoutPriorRead, @readCountV2, @readEditRatioV2,
          @editsWithoutPriorReadV2, @userInterrupts, @editChurnCount,
          @tellsCount, @prFixAttempts, @validationPassed,
          @inputTokens, @outputTokens, @costUsd,
          @runtime, @profileName, @model, @finalStatus, @completedAt, @computedAt
        )
        ON CONFLICT(pod_id) DO UPDATE SET
          score = CASE WHEN pod_quality_scores.algorithm_version = 1
            THEN pod_quality_scores.score ELSE excluded.score END,
          score_v2 = excluded.score_v2,
          algorithm_version = excluded.algorithm_version,
          inspection_availability = excluded.inspection_availability,
          read_count = CASE WHEN pod_quality_scores.algorithm_version = 1
            THEN pod_quality_scores.read_count ELSE excluded.read_count END,
          edit_count = excluded.edit_count,
          read_edit_ratio = CASE WHEN pod_quality_scores.algorithm_version = 1
            THEN pod_quality_scores.read_edit_ratio ELSE excluded.read_edit_ratio END,
          edits_without_prior_read = CASE WHEN pod_quality_scores.algorithm_version = 1
            THEN pod_quality_scores.edits_without_prior_read
            ELSE excluded.edits_without_prior_read END,
          read_count_v2 = excluded.read_count_v2,
          read_edit_ratio_v2 = excluded.read_edit_ratio_v2,
          edits_without_prior_read_v2 = excluded.edits_without_prior_read_v2,
          user_interrupts = excluded.user_interrupts,
          edit_churn_count = excluded.edit_churn_count,
          tells_count = excluded.tells_count,
          pr_fix_attempts = excluded.pr_fix_attempts,
          validation_passed = excluded.validation_passed,
          input_tokens = excluded.input_tokens,
          output_tokens = excluded.output_tokens,
          cost_usd = excluded.cost_usd,
          runtime = excluded.runtime,
          profile_name = excluded.profile_name,
          model = excluded.model,
          final_status = excluded.final_status,
          completed_at = excluded.completed_at,
          computed_at = excluded.computed_at`,
      ).run({
        podId: score.podId,
        legacyScore: score.score ?? 0,
        score: score.score,
        algorithmVersion: score.algorithmVersion,
        inspectionAvailability: score.inspectionAvailability,
        readCount: score.readCount ?? 0,
        readCountV2: score.readCount,
        editCount: score.editCount,
        readEditRatio: score.readEditRatio ?? 5,
        readEditRatioV2: score.readEditRatio,
        editsWithoutPriorRead: score.editsWithoutPriorRead ?? 0,
        editsWithoutPriorReadV2: score.editsWithoutPriorRead,
        userInterrupts: score.userInterrupts,
        editChurnCount: score.editChurnCount,
        tellsCount: score.tellsCount,
        prFixAttempts: score.prFixAttempts,
        validationPassed: score.validationPassed === null ? null : score.validationPassed ? 1 : 0,
        inputTokens: score.inputTokens,
        outputTokens: score.outputTokens,
        costUsd: score.costUsd,
        runtime: score.runtime,
        profileName: score.profileName,
        model: score.model,
        finalStatus: score.finalStatus,
        completedAt: score.completedAt,
        computedAt: score.computedAt,
      });
    },

    get(podId: string): PodQualityScore | null {
      const row = db.prepare(`${ATTEMPT_COMPATIBILITY_PROJECTION} WHERE q.pod_id = ?`).get(podId) as
        | Record<string, unknown>
        | undefined;
      return row ? rowToScore(row) : null;
    },

    list(filters: QualityScoreFilters = {}): PodQualityScore[] {
      const where: string[] = [
        'projected.algorithm_version = @algorithmVersion',
        "projected.inspection_availability = 'available'",
      ];
      const params: Record<string, unknown> = {};
      params.algorithmVersion = QUALITY_SCORE_ALGORITHM_VERSION;
      if (filters.runtime) {
        where.push('projected.runtime = @runtime');
        params.runtime = filters.runtime;
      }
      if (filters.model) {
        where.push('projected.model = @model');
        params.model = filters.model;
      }
      if (filters.profileName) {
        where.push('projected.profile_name = @profileName');
        params.profileName = filters.profileName;
      }
      if (filters.since) {
        where.push('projected.computed_at >= @since');
        params.since = filters.since;
      }
      const limit = filters.limit ?? 200;
      params.limit = limit;
      const sql = `SELECT * FROM (${ATTEMPT_COMPATIBILITY_PROJECTION}) projected${
        where.length ? ` WHERE ${where.join(' AND ')}` : ''
      } ORDER BY projected.computed_at DESC LIMIT @limit`;
      const rows = db.prepare(sql).all(params) as Record<string, unknown>[];
      return rows.map(rowToScore);
    },

    listStale(limit: number, afterPodId?: string): PodQualityScore[] {
      const rows = db
        .prepare(
          `SELECT * FROM (${ATTEMPT_COMPATIBILITY_PROJECTION}) projected
           WHERE projected.algorithm_version <> @algorithmVersion
             AND (@afterPodId IS NULL OR projected.pod_id > @afterPodId)
           ORDER BY projected.pod_id ASC
           LIMIT @limit`,
        )
        .all({
          algorithmVersion: QUALITY_SCORE_ALGORITHM_VERSION,
          afterPodId: afterPodId ?? null,
          limit,
        }) as Record<string, unknown>[];
      return rows.map(rowToScore);
    },

    getTrends(days = 30): QualityTrend[] {
      const rows = db
        .prepare(
          `SELECT
            date(completed_at) AS day,
            ROUND(AVG(score), 1) AS avg_score,
            COUNT(*) AS pod_count,
            projected.runtime,
            projected.model
          FROM (${ATTEMPT_COMPATIBILITY_PROJECTION}) projected
          WHERE completed_at > datetime('now', '-' || @days || ' days')
            AND algorithm_version = @algorithmVersion
            AND inspection_availability = 'available'
          GROUP BY date(completed_at), projected.runtime, projected.model
          ORDER BY day DESC`,
        )
        .all({ days, algorithmVersion: QUALITY_SCORE_ALGORITHM_VERSION }) as Record<
        string,
        unknown
      >[];
      return rows.map(rowToTrend);
    },

    getQualityAnalytics(days: number): QualityAnalyticsResponse {
      // Fetch all scores in the trailing window.
      const scoreRows = db
        .prepare(
          `SELECT * FROM (${ATTEMPT_COMPATIBILITY_PROJECTION}) projected
           WHERE completed_at >= datetime('now', '-' || @days || ' days')
             AND algorithm_version = @algorithmVersion
             AND inspection_availability = 'available'
           ORDER BY completed_at DESC`,
        )
        .all({ days, algorithmVersion: QUALITY_SCORE_ALGORITHM_VERSION }) as Record<
        string,
        unknown
      >[];
      const scores = scoreRows.map(rowToScore);
      const total = scores.length;

      // Single pass: compute summary counts, sparkline buckets, histogram, and reasons.
      const BUCKETS = [
        '0-9',
        '10-19',
        '20-29',
        '30-39',
        '40-49',
        '50-59',
        '60-69',
        '70-79',
        '80-89',
        '90-100',
      ];
      let redCount = 0;
      let yellowCount = 0;
      let greenCount = 0;
      let scoreSum = 0;
      const dayBuckets = new Map<string, { sum: number; count: number }>();
      const distCounts = new Array<number>(10).fill(0);
      const reasons = {
        lowReadEditRatio: 0,
        editsWithoutPriorRead: 0,
        userInterrupts: 0,
        validationFailed: 0,
        prFixAttempts: 0,
        editChurn: 0,
        tells: 0,
      };
      for (const s of scores) {
        const score = s.score ?? 0;
        scoreSum += score;
        if (score < 60) redCount++;
        else if (score < 80) yellowCount++;
        else greenCount++;

        const day = s.completedAt.slice(0, 10);
        const b = dayBuckets.get(day) ?? { sum: 0, count: 0 };
        b.sum += score;
        b.count++;
        dayBuckets.set(day, b);

        distCounts[Math.min(Math.floor(score / 10), 9)]++;

        if ((s.readEditRatio ?? 0) < 1 && s.editCount > 0) reasons.lowReadEditRatio++;
        if ((s.editsWithoutPriorRead ?? 0) > 0) reasons.editsWithoutPriorRead++;
        if (s.userInterrupts > 0) reasons.userInterrupts++;
        if (s.validationPassed === false) reasons.validationFailed++;
        if (s.prFixAttempts > 0) reasons.prFixAttempts++;
        if (s.editChurnCount > 0) reasons.editChurn++;
        if (s.tellsCount > 0) reasons.tells++;
      }
      const avgScore = total > 0 ? scoreSum / total : 0;

      // deltaVsPrior — the immediately preceding window of the same length.
      const priorAgg = db
        .prepare(
          `SELECT AVG(score) AS avgScore, COUNT(*) AS cnt
           FROM (${ATTEMPT_COMPATIBILITY_PROJECTION}) projected
           WHERE completed_at >= datetime('now', '-' || @priorDays || ' days')
             AND completed_at <  datetime('now', '-' || @days    || ' days')
             AND algorithm_version = @algorithmVersion
             AND inspection_availability = 'available'`,
        )
        .get({
          priorDays: days * 2,
          days,
          algorithmVersion: QUALITY_SCORE_ALGORITHM_VERSION,
        }) as { avgScore: number | null; cnt: number };

      let deltaValue = 0;
      let deltaDirection: 'up' | 'down' | 'flat' = 'flat';
      if (priorAgg.cnt > 0 && priorAgg.avgScore !== null) {
        deltaValue = avgScore - priorAgg.avgScore;
        deltaDirection = deltaValue > 0 ? 'up' : deltaValue < 0 ? 'down' : 'flat';
      }

      // Sparkline — one entry per day in the window; fill empty days with zeros.
      const nowMs = Date.now();
      const allDays = Array.from({ length: days }, (_, i) =>
        new Date(nowMs - (days - 1 - i) * 86_400_000).toISOString().slice(0, 10),
      );
      const sparkline = allDays.map((day) => {
        const b = dayBuckets.get(day);
        return b && b.count > 0
          ? { day, avgScore: b.sum / b.count, podCount: b.count }
          : { day, avgScore: 0, podCount: 0 };
      });

      const distribution = BUCKETS.map((bucket, i) => ({ bucket, count: distCounts[i] ?? 0 }));

      return {
        summary: {
          totalPodsScored: total,
          avgScore,
          redCount,
          yellowCount,
          greenCount,
          deltaVsPrior: { value: deltaValue, direction: deltaDirection },
        },
        sparkline,
        distribution,
        reasons,
        scores,
      };
    },
  };
}
