export interface CostAnalyticsResponse {
  /** Total effective cost over the trailing window. */
  total: number;
  /** Length always equals `days` from the query. */
  sparkline: Array<{ day: string; costUsd: number }>;
  /** Delta vs the immediately preceding window of the same length. */
  deltaVsPrior: { value: number; direction: 'up' | 'down' | 'flat' };
  /** Stacked bar segments. Order: agent_initial, rework_1..N, review, plan_eval, legacy. */
  byPhase: Array<{ phase: string; costUsd: number }>;
  /** Profile × model breakdown for the matrix view. */
  byProfileModel: Array<{
    profile: string;
    model: string | null;
    costUsd: number;
    podCount: number;
  }>;
  /** Top 10 most expensive pods in the window. */
  top10: Array<{
    podId: string;
    profile: string;
    model: string | null;
    finalStatus: 'complete' | 'killed' | 'failed' | 'rejected';
    costUsd: number;
    completedAt: string;
  }>;
  /** Strict waste — pods with no merge outcome. */
  waste: {
    total: number;
    podCount: number;
  };
}
