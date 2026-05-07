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

// ── Safety / Guardrails analytics ────────────────────────────────────────────

export type SafetyEventKind = 'pii' | 'injection';

export type SafetyEventSource =
  | 'action_response'
  | 'mcp_proxy'
  | 'issue_body'
  | 'claude_md_section'
  | 'skill_content'
  | 'pod_input'
  | 'event_payload'; // unwired today; reserved for when event-bus content processing is enabled

export type NetworkPolicyBucket = 'allow-all' | 'restricted' | 'deny-all' | 'unknown';

export interface SafetyAnalyticsResponse {
  /** High-level totals over the trailing window. Cohort = terminal:
   *  output_mode != 'workspace' AND status IN ('complete','killed','failed')
   *  AND completed_at IN window. */
  summary: {
    /** Total guardrail-fires in window (PII + injection rows). */
    totalEvents: number;
    /** Per-kind counts. */
    byKind: { pii: number; injection: number };
    /** Quarantine flag count = action_audit rows in window where quarantine_score > 0.
     *  High-risk = quarantine_score >= 0.7. */
    quarantineCount: number;
    quarantineHighRiskCount: number;
    /** Length always equals `days` from the query. */
    sparkline: Array<{ day: string; count: number }>;
    /** Direction: 'up' when current > prior by >0, 'down' when <0, 'flat' otherwise.
     *  value = signed difference in event count. */
    deltaVsPrior: { value: number; direction: 'up' | 'down' | 'flat' };
  };

  /** Pattern-level breakdown across both kinds.
   *  PII patterns sourced from action_audit.pii_categories (forward-only) AND
   *  safety_events kind='pii' rows. Pre-Phase-4 action_audit rows with
   *  pii_detected=1 AND pii_categories=NULL bucket as 'unknown'.
   *  Injection patterns come exclusively from safety_events kind='injection'. */
  byPattern: Array<{
    kind: SafetyEventKind;
    patternName: string; // e.g. 'api-key', 'direct-instruction', 'unknown'
    count: number;
  }>;

  /** Per-source breakdown. */
  bySource: Array<{ source: SafetyEventSource; count: number }>;

  /** Quarantine score histogram, 10 buckets [0.0..0.1, 0.1..0.2, ..., 0.9..1.0].
   *  Empty buckets emit count=0. Source: action_audit.quarantine_score. */
  quarantineHistogram: Array<{ bucket: string; count: number }>;

  /** Pods that triggered ≥1 safety_events row in window. Up to 50 entries
   *  ordered by lastEventAt DESC. Pods with NULL pod_id aggregate under
   *  the synthetic '__pre_creation__' group. */
  byPod: Array<{
    podId: string | '__pre_creation__';
    profile: string | null; // null when podId is __pre_creation__
    eventCount: number;
    lastEventAt: string; // ISO
    /** Up to 5 most recent injection rows; payload_excerpt + pattern + severity. */
    topInjections: Array<{
      patternName: string;
      severity: number | null;
      payloadExcerpt: string; // <= 256 chars, post-sanitize
      createdAt: string;
    }>;
  }>;

  /** Network-policy distribution over the terminal cohort.
   *  Source: pods.network_policy_resolved (snapshotted at provisioning).
   *  Pods with NULL value bucket as 'unknown' (pre-migration pods). */
  networkPolicy: Array<{ bucket: NetworkPolicyBucket; count: number }>;

  /** Latest fleet-wide audit-chain verification result.
   *  Null fields when no verification has ever been run. */
  auditChain: {
    lastVerifiedAt: string | null; // ISO
    valid: boolean | null; // null when never run
    totalPods: number | null;
    totalEntries: number | null;
    firstMismatch: { podId: string; rowId: number; reason: string } | null;
  };
}

export interface AuditChainVerifyResponse {
  /** True when every pod's chain verifies. */
  valid: boolean;
  /** Number of distinct pod_id values walked. */
  totalPods: number;
  /** Total action_audit rows verified. */
  totalEntries: number;
  /** Set when valid=false. */
  firstMismatch: { podId: string; rowId: number; reason: string } | null;
  /** ISO timestamp written into audit_chain_verifications. */
  ranAt: string;
}
