import type Database from 'better-sqlite3';

export interface ProviderUsageProjection {
  count: number;
  settledCount: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
  knownEstimatedCostUsd?: number | null;
}

/** Corrections replace their original segment; legacy pod totals are never an
 * additional source of spend when provider segments exist. A zero subtotal is
 * recorded usage, not proof of complete billing or permission to infer pricing. */
export function readProviderUsage(
  db: Database.Database,
  podId: string,
  includeHistory = false,
): ProviderUsageProjection {
  const attempts = includeHistory ? 'retained_provider_attempts' : 'provider_attempts';
  const corrections = includeHistory
    ? 'retained_provider_attempt_telemetry_corrections'
    : 'provider_attempt_telemetry_corrections';
  return db
    .prepare(`SELECT COUNT(*) AS count, SUM(a.ended_at IS NOT NULL) AS settledCount,
    SUM(COALESCE(c.input_tokens, a.input_tokens)) AS inputTokens,
    SUM(COALESCE(c.output_tokens, a.output_tokens)) AS outputTokens,
    SUM(COALESCE(c.cost_usd, a.cost_usd)) AS costUsd,
    SUM(CASE WHEN c.source = 'codex_rollout' THEN c.cost_usd ELSE 0 END) AS knownEstimatedCostUsd
    FROM ${attempts} a LEFT JOIN ${corrections} c
      ON c.pod_id = a.pod_id AND c.ordinal = a.ordinal WHERE a.pod_id = ?`)
    .get(podId) as ProviderUsageProjection;
}
