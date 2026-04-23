import type { PodQualityScore, RuntimeType } from '@autopod/shared';
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
    tellsCount: row.tells_count as number,
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

export function createQualityScoreRepository(db: Database.Database): QualityScoreRepository {
  return {
    insert(score: PodQualityScore): void {
      // ON CONFLICT REPLACE — re-running a pod (fix-pod flow) should overwrite
      // its prior score, not raise a unique-constraint error.
      db.prepare(
        `INSERT INTO pod_quality_scores (
          pod_id, score, read_count, edit_count, read_edit_ratio,
          edits_without_prior_read, user_interrupts, tells_count,
          input_tokens, output_tokens, cost_usd,
          runtime, profile_name, model, final_status, completed_at, computed_at
        ) VALUES (
          @podId, @score, @readCount, @editCount, @readEditRatio,
          @editsWithoutPriorRead, @userInterrupts, @tellsCount,
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
          tells_count = excluded.tells_count,
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
        tellsCount: score.tellsCount,
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
  };
}
