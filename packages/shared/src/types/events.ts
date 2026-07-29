import type { EscalationRequest, EscalationResponse } from './escalation.js';
import type { MemoryCandidate, MemoryEntry } from './memory.js';
import type { PodStatus, PodSummary } from './pod.js';
import type {
  OperatorActor,
  PodsitterAction,
  PodsitterDecisionOutcome,
  PodsitterProviderCircuitStatus,
} from './podsitter.js';
import type { ReadinessApproval, ReadinessStatus } from './readiness.js';
import type { AgentEvent } from './runtime.js';
import type {
  AdvisoryBrowserQaResult,
  BuildResult,
  FactValidationResult,
  HealthResult,
  LintResult,
  PageResult,
  SastResult,
  SetupResult,
  TaskReviewResult,
  ValidationOverride,
  ValidationResult,
} from './validation.js';

export type ValidationPhase =
  | 'setup'
  | 'build'
  | 'test'
  | 'lint'
  | 'sast'
  | 'health'
  | 'pages'
  | 'facts'
  | 'review'
  | 'advisory';

export type SystemEvent =
  | PodCreatedEvent
  | PodStatusChangedEvent
  | AgentActivityEvent
  | ValidationStartedEvent
  | ValidationCompletedEvent
  | ValidationPhaseStartedEvent
  | ValidationPhaseCompletedEvent
  | EscalationCreatedEvent
  | EscalationResolvedEvent
  | PodCompletedEvent
  | MemorySuggestionCreatedEvent
  | MemoryCandidateCreatedEvent
  | MemoryCandidateUpdatedEvent
  | ValidationOverrideQueuedEvent
  | TokenBudgetWarningEvent
  | TokenBudgetExceededEvent
  | ScheduledJobCatchupRequestedEvent
  | ScheduledJobFiredEvent
  | IssueWatcherPickedUpEvent
  | IssueWatcherCompletedEvent
  | IssueWatcherErrorEvent
  | PodWorktreeCompromisedEvent
  | PodPreflightOverlapEvent
  | PodReadinessApprovedEvent
  | HostResumedEvent
  | FirewallDeniedEvent
  | PodsitterAttentionQueuedEvent
  | PodsitterDecisionStartedEvent
  | PodsitterDecisionCompletedEvent
  | PodsitterDecisionFailedEvent
  | PodsitterActionExecutedEvent
  | PodsitterActionRejectedEvent
  | PodsitterProviderLimitedEvent
  | PodsitterProviderRecoveredEvent
  | PodsitterActivationChangedEvent
  | PodsitterSandboxCleanupFailedEvent;

export interface PodsitterAttentionQueuedEvent {
  type: 'podsitter.attention_queued';
  timestamp: string;
  podId: string;
  attentionId: string;
  attentionSignature: string;
}

export interface PodsitterDecisionStartedEvent {
  type: 'podsitter.decision_started';
  timestamp: string;
  podId: string;
  decisionId: string;
  attentionSignature: string;
  providerAccountId: string;
  model: string;
}

export interface PodsitterDecisionCompletedEvent {
  type: 'podsitter.decision_completed';
  timestamp: string;
  podId: string;
  decisionId: string;
  action: PodsitterAction;
  outcome: PodsitterDecisionOutcome;
  evidenceRefs: string[];
}

export interface PodsitterDecisionFailedEvent {
  type: 'podsitter.decision_failed';
  timestamp: string;
  podId: string;
  decisionId: string;
  failureCode: string;
}

export interface PodsitterActionExecutedEvent {
  type: 'podsitter.action_executed';
  timestamp: string;
  podId: string;
  decisionId: string;
  action: PodsitterAction;
  actor: OperatorActor;
}

export interface PodsitterActionRejectedEvent {
  type: 'podsitter.action_rejected';
  timestamp: string;
  podId: string;
  decisionId: string;
  action: PodsitterAction;
  policyResult: string;
}

export interface PodsitterProviderLimitedEvent {
  type: 'podsitter.provider_limited';
  timestamp: string;
  providerAccountId: string;
  status: Exclude<PodsitterProviderCircuitStatus, 'available'>;
  retryAt: string | null;
}

export interface PodsitterProviderRecoveredEvent {
  type: 'podsitter.provider_recovered';
  timestamp: string;
  providerAccountId: string;
}

export interface PodsitterActivationChangedEvent {
  type: 'podsitter.activation_changed';
  timestamp: string;
  enabled: boolean;
  generation: number;
  actor: OperatorActor;
}

export interface PodsitterSandboxCleanupFailedEvent {
  type: 'podsitter.system_sandbox_cleanup_failed';
  timestamp: string;
  runId: string;
  decisionId: string | null;
  failureCode: string;
}

export interface PodCreatedEvent {
  type: 'pod.created';
  timestamp: string;
  pod: PodSummary;
}

export interface PodStatusChangedEvent {
  type: 'pod.status_changed';
  timestamp: string;
  podId: string;
  previousStatus: PodStatus;
  newStatus: PodStatus;
}

export interface AgentActivityEvent {
  type: 'pod.agent_activity';
  timestamp: string;
  podId: string;
  event: AgentEvent;
}

export interface ValidationStartedEvent {
  type: 'pod.validation_started';
  timestamp: string;
  podId: string;
  attempt: number;
}

export interface ValidationCompletedEvent {
  type: 'pod.validation_completed';
  timestamp: string;
  podId: string;
  result: ValidationResult;
}

export interface ValidationPhaseStartedEvent {
  type: 'pod.validation_phase_started';
  timestamp: string;
  podId: string;
  phase: ValidationPhase;
}

export interface ValidationPhaseCompletedEvent {
  type: 'pod.validation_phase_completed';
  timestamp: string;
  podId: string;
  phase: ValidationPhase;
  /** Phase outcome — separate from "status" to avoid JSON key collisions with other events */
  phaseStatus: 'pass' | 'fail' | 'skip' | 'pending_human';
  // Exactly one of these is populated per event, matching the phase:
  setupResult?: SetupResult;
  buildResult?: BuildResult;
  testResult?: {
    status: 'pass' | 'fail' | 'skip';
    duration: number;
    stdout?: string;
    stderr?: string;
  };
  lintResult?: LintResult;
  sastResult?: SastResult;
  healthResult?: HealthResult;
  pageResults?: PageResult[];
  factResult?: FactValidationResult | null;
  reviewResult?: TaskReviewResult | null;
  advisoryResult?: AdvisoryBrowserQaResult | null;
}

export interface EscalationCreatedEvent {
  type: 'pod.escalation_created';
  timestamp: string;
  podId: string;
  escalation: EscalationRequest;
}

export interface EscalationResolvedEvent {
  type: 'pod.escalation_resolved';
  timestamp: string;
  podId: string;
  escalationId: string;
  response: EscalationResponse;
}

export interface PodCompletedEvent {
  type: 'pod.completed';
  timestamp: string;
  podId: string;
  finalStatus: 'complete' | 'killed';
  summary: PodSummary;
}

export interface PodReadinessApprovedEvent {
  type: 'pod.readiness_approved';
  timestamp: string;
  podId: string;
  status: ReadinessStatus;
  scope: ReadinessApproval['scope'];
  seriesId?: string;
  summary: string;
  reason?: string;
}

export interface MemorySuggestionCreatedEvent {
  type: 'memory.suggestion_created';
  timestamp: string;
  podId: string;
  memoryEntry: MemoryEntry;
}

export interface MemoryCandidateCreatedEvent {
  type: 'memory.candidate_created';
  timestamp: string;
  podId: string;
  candidate: MemoryCandidate;
}

export interface MemoryCandidateUpdatedEvent {
  type: 'memory.candidate_updated';
  timestamp: string;
  podId: string;
  candidate: MemoryCandidate;
}

export interface ValidationOverrideQueuedEvent {
  type: 'validation.override_queued';
  timestamp: string;
  podId: string;
  override: ValidationOverride;
}

export interface TokenBudgetWarningEvent {
  type: 'pod.token_budget_warning';
  timestamp: string;
  podId: string;
  tokensUsed: number;
  tokenBudget: number;
  percentUsed: number;
}

export interface TokenBudgetExceededEvent {
  type: 'pod.token_budget_exceeded';
  timestamp: string;
  podId: string;
  tokensUsed: number;
  tokenBudget: number;
  budgetExtensionsUsed: number;
  maxBudgetExtensions: number | null;
}

export interface ScheduledJobCatchupRequestedEvent {
  type: 'scheduled_job.catchup_requested';
  timestamp: string;
  jobId: string;
  jobName: string;
  lastRunAt: string | null;
}

export interface ScheduledJobFiredEvent {
  type: 'scheduled_job.fired';
  timestamp: string;
  jobId: string;
  jobName: string;
  podId: string;
}

export interface IssueWatcherPickedUpEvent {
  type: 'issue_watcher.picked_up';
  timestamp: string;
  profileName: string;
  issueUrl: string;
  issueTitle: string;
  podId: string;
}

export interface IssueWatcherCompletedEvent {
  type: 'issue_watcher.completed';
  timestamp: string;
  profileName: string;
  issueUrl: string;
  podId: string;
  outcome: 'done' | 'failed';
}

export interface IssueWatcherErrorEvent {
  type: 'issue_watcher.error';
  timestamp: string;
  profileName: string;
  error: string;
}

/**
 * Emitted when the daemon refuses to auto-commit because the number of staged deletions
 * exceeds the safety threshold — a strong signal that the host worktree is out of sync
 * with the container. The agent's real work may still live in the container; the user
 * should avoid retry/merge actions until the situation is manually reconciled.
 */
export interface PodWorktreeCompromisedEvent {
  type: 'pod.worktree_compromised';
  timestamp: string;
  podId: string;
  deletionCount: number;
  threshold: number;
}

export interface HostResumedEvent {
  type: 'host.resumed';
  timestamp: string;
  /** Wall-clock milliseconds the process was suspended. */
  sleptMs: number;
  /** Which detector first observed the wake. */
  detector: 'tick-gap' | 'pmset' | 'native';
  /** Pod IDs reconciled after this wake; empty at initial emit, populated by pod-manager (brief 02). */
  reconciledPodIds: string[];
}

/**
 * One sibling pod whose `touches` scope overlaps the candidate pod's scope.
 * Carried inside {@link PodPreflightOverlapEvent} and used by the daemon's
 * preflight check. Defined here in shared so the event payload and the
 * daemon-internal computation never drift apart.
 */
export interface PreflightConflict {
  conflictingPodId: string;
  conflictingPodTask: string;
  conflictingPodStatus: string;
  overlappingGlobs: Array<{ ours: string; theirs: string }>;
}

/**
 * Emitted at pod-create time when the new pod's `touches` scope overlaps the
 * scope of one or more in-flight pods on the same repo + base branch. This is
 * a *warning*, not a block — the pod still proceeds. Surfaced so desktop/CLI
 * can show "this pod overlaps with pod X" so the operator can decide whether
 * to kill one, reorder, or accept the parallel work.
 *
 * Overlap is computed via directory-prefix glob comparison (see
 * `packages/daemon/src/pods/glob-overlap.ts`) — conservative on purpose: a
 * false positive is noise, a missed conflict is a merge conflict an hour later.
 */
export interface PodPreflightOverlapEvent {
  type: 'pod.preflight_overlap';
  timestamp: string;
  podId: string;
  conflicts: PreflightConflict[];
}

/**
 * Emitted when the in-pod HAProxy egress proxy rejects an outbound TLS
 * connection because the ClientHello SNI is not on the restricted-mode
 * allowlist. The daemon's container log pump parses HAProxy's syslog
 * lines (see `containers/haproxy-deny-parser.ts`) and emits one of these
 * per denied session, so operators see "agent tried to reach X" in real
 * time in the CLI / desktop event stream rather than just a generic
 * connection error on the agent side.
 *
 * `sni` is the literal value from the ClientHello — may be `-` if the
 * client sent no SNI (rejected for that reason). `src` is the source
 * IP HAProxy logged (typically `127.0.0.1` because the iptables REDIRECT
 * hides the original source).
 */
export interface FirewallDeniedEvent {
  type: 'pod.firewall_denied';
  timestamp: string;
  podId: string;
  sni: string;
  src: string;
}
