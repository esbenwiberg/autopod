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
  /** Stacked bar segments. Order: agent_initial, rework_1..N, review, plan_eval, advisory, legacy. */
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

  /** Firewall denials observed from restricted-mode pods.
   *  Source: persisted `pod.firewall_denied` events emitted by the HAProxy deny receiver. */
  firewallDenials: {
    total: number;
    affectedPods: number;
    topHosts: Array<{ sni: string; count: number; lastDeniedAt: string }>;
    recent: Array<{ podId: string; sni: string; src: string; deniedAt: string }>;
  };

  /** Host-worktree safety incidents.
   *  Source: `pods.worktree_compromised` plus persisted `pod.worktree_compromised` events. */
  worktreeSafety: {
    currentCompromisedPods: number;
    totalIncidents: number;
    recentIncidents: Array<{
      podId: string;
      deletionCount: number;
      threshold: number;
      detectedAt: string;
    }>;
  };

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

// ── Throughput analytics ─────────────────────────────────────────────────────

/** The four states pods spend meaningful time in. The other 12 PodStatus
 *  values are transitional and excluded by design. */
export type LoadBearingStatus = 'queued' | 'running' | 'validating' | 'awaiting_input';

export interface ThroughputCohortPod {
  podId: string;
  profile: string;
  status: 'complete' | 'killed' | 'failed';
  /** ISO UTC. Desktop buckets in the user's local timezone. */
  completedAt: string;
}

export interface QueueDepthBucket {
  /** ISO UTC hour boundary (e.g. '2026-05-09T14:00:00Z'). One entry per hour in the window. */
  hour: string;
  /** Max queue depth observed during this hour. */
  max: number;
  /** Mean queue depth during this hour (60 minute-boundary samples). */
  mean: number;
}

export interface TimeInStatusBox {
  status: LoadBearingStatus;
  /** Seconds. p25/p50/p75 form the box, p90 is the whisker, max is the outlier marker.
   *  All zero when sampleCount === 0. */
  p25: number;
  p50: number;
  p75: number;
  p90: number;
  max: number;
  sampleCount: number;
}

export interface ThroughputAnalyticsResponse {
  /** High-level totals over the trailing window. Cohort = terminal:
   *  output_mode != 'workspace' AND status IN ('complete','killed','failed')
   *  AND completed_at IN window. */
  summary: {
    /** Mean pods-per-day across the window. = |cohort| / days. Returns 0 when cohort is empty. */
    podsPerDay: number;
    /** One entry per day in window (length === days). Days with zero terminal pods emit count=0. */
    podsPerDaySparkline: Array<{ day: string; count: number }>;
    /** Signed difference in mean pods/day vs the immediately-prior window of the same length. */
    podsPerDayDelta: { value: number; direction: 'up' | 'down' | 'flat' };
    /** Mean time-to-merge in seconds, restricted to status='complete' pods. 0 when none. */
    mttmSeconds: number;
    /** Live point-in-time count: pods with status IN ('queued','provisioning'). Window-independent. */
    backlog: number;
  };

  /** Per-pod entries from the terminal cohort. Capped at 5 000 most-recent entries. */
  cohort: ThroughputCohortPod[];
  cohortTruncated: boolean;

  /** Hourly queue-depth time-series. Cohort = queue-intersect. Length = days * 24. */
  queueDepth: QueueDepthBucket[];

  /** Box-plot stats per load-bearing state. Always 4 entries in order
   *  [queued, running, validating, awaiting_input]. */
  timeInStatus: TimeInStatusBox[];
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

// ── Escalations analytics ─────────────────────────────────────────────────────

/** Escalation types that require a human to look at and respond.
 *  ask_ai (agent-consults-another-AI) and request_credential (JIT vending)
 *  are explicitly excluded — they are autonomous-recovery signal, not stuck-ness. */
export type HumanAttentionKind =
  | 'ask_human'
  | 'report_blocker'
  | 'validation_override'
  | 'action_approval';

export interface EscalationsSummary {
  /** Fraction in [0, 1]. Returns 1.0 when cohortSize === 0. */
  selfRecoveryRate: number;
  /** Size of the terminal cohort over the trailing window. */
  cohortSize: number;
  /** Distinct pod count in the terminal cohort with ≥1 human-attention escalation. */
  humanAttentionPodCount: number;
  /** Total human-attention escalation rows whose pod is in the terminal cohort. */
  humanAttentionCount: number;
  /** Total ask_ai escalation rows whose pod is in the terminal cohort. */
  askAiCount: number;
  /** One entry per day in window (length === days). count = human-attention rows that day. */
  dailyHumanCountSparkline: Array<{ day: string; count: number }>;
  /** Signed absolute-fraction delta vs the prior window of the same length.
   *  delta.value = 0.05 means rate improved by 5pp. 'up' is good (more autonomy). */
  selfRecoveryRateDelta: { value: number; direction: 'up' | 'down' | 'flat' };
}

export interface AskHumanTtrBucket {
  /** One of 8 fixed labels: '<1m','1–5m','5–15m','15m–1h','1–4h','4–12h','12–24h','>24h'. */
  label: string;
  count: number;
}

export interface AskHumanTtr {
  /** Always 8 entries in the fixed label order. All-zero when no resolved rows. */
  buckets: AskHumanTtrBucket[];
  /** Sum of buckets[].count. */
  resolvedCount: number;
  /** Point-in-time count of unresolved ask_human rows created in window. Not in histogram. */
  openCount: number;
  /** Max (resolved_at − created_at) seconds across resolved cohort. 0 when empty. */
  maxSeconds: number;
}

export interface PerProfileEscalation {
  profile: string;
  podCount: number;
  escalatedCount: number;
  /** = escalatedCount / podCount. In [0, 1]. */
  rate: number;
}

export interface BlockerPattern {
  /** Verbatim trimmed description from report_blocker payload. */
  description: string;
  count: number;
  /** Up to 10 distinct pod IDs, most-recent-first. */
  podIds: string[];
}

export interface EscalationsAnalyticsResponse {
  summary: EscalationsSummary;
  askHumanTtr: AskHumanTtr;
  /** Sorted by rate DESC, ties by podCount DESC. */
  perProfile: PerProfileEscalation[];
  /** Top 10 by count DESC, ties by description ASC. Length <= 10. */
  blockerPatterns: BlockerPattern[];
}

// ── Models analytics ──────────────────────────────────────────────────────────

/** The validation stages tracked in the failure-stage matrix.
 *  Mirrors the ValidationStage union in reliability-aggregator.ts — keep in sync. */
export type ValidationStage =
  | 'build'
  | 'health'
  | 'smoke'
  | 'test'
  | 'lint'
  | 'sast'
  | 'facts'
  | 'taskReview';

/** Stage failure cell. Mirrors reliability-aggregator's profileHeatmap stage entry. */
export interface FailureStageCell {
  stage: ValidationStage;
  /** Distinct pods that ran this stage at least once over the trailing window. */
  podsRan: number;
  /** Distinct pods whose most-recent run of this stage failed. */
  podsFailed: number;
  /** = podsFailed / podsRan when podsRan > 0; else 0. In [0, 1]. */
  failureRate: number;
}

export interface FailureStageRow {
  /** Canonical model key (post-MODEL_CANONICAL coalescing). May be '<unknown>'. */
  model: string;
  /** Always 8 entries in the fixed STAGES order. Empty cohort emits all zeros. */
  stages: FailureStageCell[];
}

export interface PerModelAggregate {
  /** Canonical model key. For the unknown bucket: literal '<unknown>'. */
  model: string;
  podCount: number;
  completeCount: number;
  killedCount: number;
  failedCount: number;
  /** = completeCount / podCount. In [0, 1]. */
  successRate: number;
  /** SUM(effectiveCostUsd) including killed/failed pods. Null when model === '<unknown>'. */
  totalCostUsd: number | null;
  /** totalCostUsd / completeCount. Null when completeCount === 0 or model === '<unknown>'. */
  dollarPerPr: number | null;
  scoredCount: number;
  /** Mean pod_quality_scores.score. Null when scoredCount === 0. In [0, 100]. */
  avgQuality: number | null;
  /** Mean seconds from created_at to completed_at for complete pods. Null when completeCount === 0. */
  meanTtmSeconds: number | null;
  /** Distinct cohort pods with ≥1 human-attention escalation. */
  escalatedCount: number;
  /** = escalatedCount / podCount. In [0, 1]. */
  escalationRate: number;
  /** Sum of effectiveCostUsd for status='complete' pods only. Null when model === '<unknown>'. */
  completeCostUsd: number | null;
}

export interface PerRuntimeAggregate {
  runtime: string;
  podCount: number;
  completeCount: number;
  killedCount: number;
  failedCount: number;
  successRate: number;
  /** SUM(effectiveCostUsd) including unknown-model pods. */
  totalCostUsd: number;
  dollarPerPr: number | null;
  scoredCount: number;
  avgQuality: number | null;
  meanTtmSeconds: number | null;
  escalatedCount: number;
  escalationRate: number;
}

export interface UnknownModelSample {
  /** Verbatim pods.model string that didn't resolve. */
  rawModel: string;
  podCount: number;
}

export interface ModelsSummary {
  /** Cheapest-$/PR canonical model name (completeCount >= 5, not '<unknown>'). Null if none. */
  cheapestDollarPerPrModel: string | null;
  /** dollarPerPr value for cheapestDollarPerPrModel. Null when cheapestDollarPerPrModel is null. */
  cheapestDollarPerPr: number | null;
  /** Canonical model with the highest avgQuality (scoredCount >= 5, not '<unknown>'). Null if none. */
  bestQualityModel: string | null;
  bestQuality: number | null;
  /** Canonical model with the highest podCount (no MIN_COHORT gate). May be '<unknown>'. Null if empty. */
  mostUsedModel: string | null;
  mostUsedPodCount: number | null;
  cohortSize: number;
  /** Daily pod count for mostUsedModel. Length === days. Zero-padded. */
  mostUsedDailySparkline: Array<{ day: string; count: number }>;
  /** Signed absolute-USD delta vs the prior window (e.g. -0.42 = $0.42 cheaper).
   *  Desktop formats as %+$.2f/PR. 'down' = cheaper = good. */
  cheapestDollarPerPrDelta: { value: number; direction: 'up' | 'down' | 'flat' };
}

export interface ModelsAnalyticsResponse {
  summary: ModelsSummary;
  /** Sorted by podCount DESC, ties by model ASC. */
  byModel: PerModelAggregate[];
  /** Always 3 entries: claude / codex / copilot (in that order). */
  byRuntime: PerRuntimeAggregate[];
  /** One row per canonical model appearing in byModel (same sort order). */
  failureStageMatrix: FailureStageRow[];
  /** Up to 10 raw model strings that didn't resolve. Sorted by podCount DESC, rawModel ASC. */
  unknownModels: UnknownModelSample[];
}

// ── Memory analytics ──────────────────────────────────────────────────────────

export interface MemoryAnalyticsResponse {
  /** Trailing window in days that this response covers. */
  days: number;
  summary: {
    selectedCount: number;
    injectedCount: number;
    readCount: number;
    searchedCount: number;
    appliedCount: number;
    notApplicableCount: number;
    harmfulStaleCount: number;
    notReportedCount: number;
    candidateCount: number;
    approvedCandidateCount: number;
  };
  /** Impact comparison: pods with injected memory vs pods without. */
  impact: {
    cohortSize: number;
    comparisonCohortSize: number;
    qualityDelta: number | null;
    validationFailureDelta: number | null;
    fixAttemptDelta: number | null;
    escalationDelta: number | null;
    costDeltaUsd: number | null;
    reworkDelta: number | null;
    firstPassRateDelta: number | null;
    /** Average completion-duration delta in hours. Negative means faster with memory. */
    throughputDelta: number | null;
  };
  /** Top memories by usage, ordered by selectedCount DESC. */
  topMemories: Array<{
    memoryId: string;
    path: string;
    selectedCount: number;
    injectedCount: number;
    appliedCount: number;
    harmfulStaleCount: number;
    impactSummary: string | null;
  }>;
}
