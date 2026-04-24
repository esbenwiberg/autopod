import type { PodQualityScore, QualityTrend, RuntimeType } from '@autopod/shared';
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
  getTrends(days?: number): QualityTrend[];
}

function rowToScore(row: Record<string, unknown>): PodQualityScore {
  return {
    podId: row.pod_id as string,
    score: row.score as number,
    readCount: row.read_count as number,
    editCount: row.edit_count as number,
    readEditRatio: row.read_edit_ratio as number,
    editsWithoutPriorRead: row.edits_without_prior_read as number,
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
          pod_id, score, read_count, edit_count, read_edit_ratio,
          edits_without_prior_read, user_interrupts, edit_churn_count,
          tells_count, pr_fix_attempts, validation_passed,
          input_tokens, output_tokens, cost_usd,
          runtime, profile_name, model, final_status, completed_at, computed_at
        ) VALUES (
          @podId, @score, @readCount, @editCount, @readEditRatio,
          @editsWithoutPriorRead, @userInterrupts, @editChurnCount,
          @tellsCount, @prFixAttempts, @validationPassed,
          @inputTokens, @outputTokens, @costUsd,
          @runtime, @profileName, @model, @finalStatus, @completedAt, @computedAt
        )
        ON CONFLICT(pod_id) DO UPDATE SET
          score = excluded.score,
          read_count = excluded.read_count,
          edit_count = excluded.edit_count,
          read_edit_ratio = excluded.read_edit_ratio,
          edits_without_prior_read = excluded.edits_without_prior_read,
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
        score: score.score,
        readCount: score.readCount,
        editCount: score.editCount,
        readEditRatio: score.readEditRatio,
        editsWithoutPriorRead: score.editsWithoutPriorRead,
        userInterrupts: score.userInterrupts,
        editChurnCount: score.editChurnCount,
        tellsCount: score.tellsCount,
        prFixAttempts: score.prFixAttempts,
        validationPassed:
          score.validationPassed === null ? null : score.validationPassed ? 1 : 0,
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
      const row = db.prepare('SELECT * FROM pod_quality_scores WHERE pod_id = ?').get(podId) as
        | Record<string, unknown>
        | undefined;
      return row ? rowToScore(row) : null;
    },

    list(filters: QualityScoreFilters = {}): PodQualityScore[] {
      const where: string[] = [];
      const params: Record<string, unknown> = {};
      if (filters.runtime) {
        where.push('runtime = @runtime');
        params.runtime = filters.runtime;
      }
      if (filters.model) {
        where.push('model = @model');
        params.model = filters.model;
      }
      if (filters.profileName) {
        where.push('profile_name = @profileName');
        params.profileName = filters.profileName;
      }
      if (filters.since) {
        where.push('computed_at >= @since');
        params.since = filters.since;
      }
      const limit = filters.limit ?? 200;
      params.limit = limit;
      const sql = `SELECT * FROM pod_quality_scores${
        where.length ? ` WHERE ${where.join(' AND ')}` : ''
      } ORDER BY computed_at DESC LIMIT @limit`;
      const rows = db.prepare(sql).all(params) as Record<string, unknown>[];
      return rows.map(rowToScore);
    },

    getTrends(days = 30): QualityTrend[] {
      const rows = db
        .prepare(
          `SELECT
            date(completed_at) AS day,
            ROUND(AVG(score), 1) AS avg_score,
            COUNT(*) AS pod_count,
            runtime,
            model
          FROM pod_quality_scores
          WHERE completed_at > datetime('now', '-' || @days || ' days')
          GROUP BY date(completed_at), runtime, model
          ORDER BY day DESC`,
        )
        .all({ days }) as Record<string, unknown>[];
      return rows.map(rowToTrend);
    },
  };
}
