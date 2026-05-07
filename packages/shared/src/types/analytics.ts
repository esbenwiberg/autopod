import type { PodQualityScore } from './pod.js';

export interface QualityAnalyticsResponse {
  /** High-level totals over the trailing window. */
  summary: {
    totalPodsScored: number;
    avgScore: number;
    redCount: number; // score < 60
    yellowCount: number; // 60..79
    greenCount: number; // 80..100
    deltaVsPrior: { value: number; direction: 'up' | 'down' | 'flat' };
  };
  /** Length always equals `days` from the query. */
  sparkline: Array<{ day: string; avgScore: number; podCount: number }>;
  /** Fixed 10 buckets: 0-9, 10-19, ..., 90-100. Empty buckets have count 0. */
  distribution: Array<{ bucket: string; count: number }>;
  /** Counts of pods that triggered each persisted signal. */
  reasons: {
    lowReadEditRatio: number;
    editsWithoutPriorRead: number;
    userInterrupts: number;
    validationFailed: number;
    prFixAttempts: number;
    editChurn: number;
    tells: number;
  };
  /** Full list of scores in the window — drill table renders from this. */
  scores: PodQualityScore[];
}

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
