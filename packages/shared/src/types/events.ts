import type { EscalationRequest, EscalationResponse } from './escalation.js';
import type { MemoryEntry } from './memory.js';
import type { AgentEvent } from './runtime.js';
import type { SessionStatus, SessionSummary } from './session.js';
import type {
  AcValidationResult,
  BuildResult,
  HealthResult,
  PageResult,
  TaskReviewResult,
  ValidationOverride,
  ValidationResult,
} from './validation.js';

export type ValidationPhase = 'build' | 'test' | 'health' | 'pages' | 'ac' | 'review';

export type SystemEvent =
  | SessionCreatedEvent
  | SessionStatusChangedEvent
  | AgentActivityEvent
  | ValidationStartedEvent
  | ValidationCompletedEvent
  | ValidationPhaseStartedEvent
  | ValidationPhaseCompletedEvent
  | EscalationCreatedEvent
  | EscalationResolvedEvent
  | SessionCompletedEvent
  | MemorySuggestionCreatedEvent
  | ValidationOverrideQueuedEvent
  | TokenBudgetWarningEvent
  | TokenBudgetExceededEvent
  | ScheduledJobCatchupRequestedEvent
  | ScheduledJobFiredEvent
  | IssueWatcherPickedUpEvent
  | IssueWatcherCompletedEvent
  | IssueWatcherErrorEvent;

export interface SessionCreatedEvent {
  type: 'session.created';
  timestamp: string;
  session: SessionSummary;
}

export interface SessionStatusChangedEvent {
  type: 'session.status_changed';
  timestamp: string;
  sessionId: string;
  previousStatus: SessionStatus;
  newStatus: SessionStatus;
}

export interface AgentActivityEvent {
  type: 'session.agent_activity';
  timestamp: string;
  sessionId: string;
  event: AgentEvent;
}

export interface ValidationStartedEvent {
  type: 'session.validation_started';
  timestamp: string;
  sessionId: string;
  attempt: number;
}

export interface ValidationCompletedEvent {
  type: 'session.validation_completed';
  timestamp: string;
  sessionId: string;
  result: ValidationResult;
}

export interface ValidationPhaseStartedEvent {
  type: 'session.validation_phase_started';
  timestamp: string;
  sessionId: string;
  phase: ValidationPhase;
}

export interface ValidationPhaseCompletedEvent {
  type: 'session.validation_phase_completed';
  timestamp: string;
  sessionId: string;
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
  healthResult?: HealthResult;
  pageResults?: PageResult[];
  acResult?: AcValidationResult | null;
  reviewResult?: TaskReviewResult | null;
}

export interface EscalationCreatedEvent {
  type: 'session.escalation_created';
  timestamp: string;
  sessionId: string;
  escalation: EscalationRequest;
}

export interface EscalationResolvedEvent {
  type: 'session.escalation_resolved';
  timestamp: string;
  sessionId: string;
  escalationId: string;
  response: EscalationResponse;
}

export interface SessionCompletedEvent {
  type: 'session.completed';
  timestamp: string;
  sessionId: string;
  finalStatus: 'complete' | 'killed';
  summary: SessionSummary;
}

export interface MemorySuggestionCreatedEvent {
  type: 'memory.suggestion_created';
  timestamp: string;
  sessionId: string;
  memoryEntry: MemoryEntry;
}

export interface ValidationOverrideQueuedEvent {
  type: 'validation.override_queued';
  timestamp: string;
  sessionId: string;
  override: ValidationOverride;
}

export interface TokenBudgetWarningEvent {
  type: 'session.token_budget_warning';
  timestamp: string;
  sessionId: string;
  tokensUsed: number;
  tokenBudget: number;
  percentUsed: number;
}

export interface TokenBudgetExceededEvent {
  type: 'session.token_budget_exceeded';
  timestamp: string;
  sessionId: string;
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
  sessionId: string;
}

export interface IssueWatcherPickedUpEvent {
  type: 'issue_watcher.picked_up';
  timestamp: string;
  profileName: string;
  issueUrl: string;
  issueTitle: string;
  sessionId: string;
}

export interface IssueWatcherCompletedEvent {
  type: 'issue_watcher.completed';
  timestamp: string;
  profileName: string;
  issueUrl: string;
  sessionId: string;
  outcome: 'done' | 'failed';
}

export interface IssueWatcherErrorEvent {
  type: 'issue_watcher.error';
  timestamp: string;
  profileName: string;
  error: string;
}
