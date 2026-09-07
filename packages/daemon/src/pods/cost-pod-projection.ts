import type { Pod } from '@autopod/shared';

/** Read-only cost source; contains no full control-plane evidence. */
export type PodCostSource = Pick<
  Pod,
  | 'id'
  | 'profileName'
  | 'status'
  | 'model'
  | 'runtime'
  | 'completedAt'
  | 'options'
  | 'inputTokens'
  | 'outputTokens'
  | 'costUsd'
  | 'tokenTelemetryAccuracy'
  | 'recordDiagnostics'
> & { phaseTokenUsage: unknown };

export const COST_PHASE_JSON_MAX_BYTES = 64 * 1024;
// Bounds apply inside SQLite before JSON crosses into the JS process.
export const COST_PHASE_COLUMNS = `
  CASE WHEN length(CAST(phase_token_usage AS BLOB)) <= ${COST_PHASE_JSON_MAX_BYTES}
    THEN phase_token_usage ELSE NULL END AS phase_token_usage,
  length(CAST(phase_token_usage AS BLOB)) > ${COST_PHASE_JSON_MAX_BYTES} AS phase_token_usage_oversized`;
export const COST_POD_COLUMNS = `id, profile_name, status, model, runtime, completed_at,
  input_tokens, output_tokens, cost_usd, ${COST_PHASE_COLUMNS}, token_telemetry_accuracy,
  output_mode, agent_mode, output_target, validate, promotable`;
