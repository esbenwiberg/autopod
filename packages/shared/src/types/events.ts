import type { EscalationRequest, EscalationResponse } from './escalation.js';
import type { MemoryEntry } from './memory.js';
import type { PodStatus, PodSummary } from './pod.js';
import type { AgentEvent } from './runtime.js';
import type {
  AcValidationResult,
  BuildResult,
  HealthResult,
  LintResult,
  PageResult,
  SastResult,
  TaskReviewResult,
  ValidationOverride,
  ValidationResult,
} from './validation.js';

export type ValidationPhase =
  | 'build'
  | 'test'
  | 'lint'
  | 'sast'
  | 'health'
  | 'pages'
  | 'ac'
  | 'review';

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
  | ValidationOverrideQueuedEvent
  | TokenBudgetWarningEvent
  | TokenBudgetExceededEvent
  | ScheduledJobCatchupRequestedEvent
  | ScheduledJobFiredEvent
  | IssueWatcherPickedUpEvent
  | IssueWatcherCompletedEvent
  | IssueWatcherErrorEvent
  | PodWorktreeCompromisedEvent
  | PodPreflightOverlapEvent;

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
  phaseStatus: 'pass' | 'fail' | 'skip';
  // Exactly one of these is populated per event, matching the phase:
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
  acResult?: AcValidationResult | null;
  reviewResult?: TaskReviewResult | null;
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

export interface MemorySuggestionCreatedEvent {
  type: 'memory.suggestion_created';
  timestamp: string;
  podId: string;
  memoryEntry: MemoryEntry;
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
  conflicts: Array<{
    conflictingPodId: string;
    conflictingPodTask: string;
    conflictingPodStatus: string;
    overlappingGlobs: Array<{ ours: string; theirs: string }>;
  }>;
}
