import type { OutputMode } from './actions.js';
import type { EscalationRequest } from './escalation.js';
import type { ExecutionTarget, PimGroupConfig } from './profile.js';
import type { RuntimeType } from './runtime.js';
import type { TaskSummary } from './task-summary.js';
import type { ValidationOverride, ValidationResult } from './validation.js';

export type SessionStatus =
  | 'queued'
  | 'provisioning'
  | 'running'
  | 'awaiting_input'
  | 'validating'
  | 'validated'
  | 'failed'
  | 'review_required'
  | 'approved'
  | 'merging'
  | 'merge_pending'
  | 'complete'
  | 'paused'
  | 'killing'
  | 'killed';

export interface Session {
  id: string;
  profileName: string;
  task: string;
  status: SessionStatus;
  model: string;
  runtime: RuntimeType;
  executionTarget: ExecutionTarget;
  branch: string;
  containerId: string | null;
  worktreePath: string | null;
  validationAttempts: number;
  maxValidationAttempts: number;
  lastValidationResult: ValidationResult | null;
  lastCorrectionMessage: string | null;
  pendingEscalation: EscalationRequest | null;
  escalationCount: number;
  skipValidation: boolean;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  updatedAt: string;
  userId: string;
  filesChanged: number;
  linesAdded: number;
  linesRemoved: number;
  previewUrl: string | null;
  prUrl: string | null;
  mergeBlockReason: string | null;
  plan: { summary: string; steps: string[] } | null;
  progress: {
    phase: string;
    description: string;
    currentPhase: number;
    totalPhases: number;
  } | null;
  acceptanceCriteria: string[] | null;
  claudeSessionId: string | null;
  outputMode: OutputMode;
  baseBranch: string | null;
  acFrom: string | null;
  recoveryWorktreePath: string | null;
  reworkReason: string | null;
  lastHeartbeatAt: string | null;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  commitCount: number;
  lastCommitAt: string | null;
  startCommitSha: string | null;
  linkedSessionId: string | null;
  taskSummary: TaskSummary | null;
  validationOverrides: ValidationOverride[] | null;
  pimGroups: PimGroupConfig[] | null;
}

export interface CreateSessionRequest {
  profileName: string;
  task: string;
  model?: string;
  runtime?: RuntimeType;
  executionTarget?: ExecutionTarget;
  branch?: string;
  /** Override the profile's branch prefix for this session (e.g. 'hotfix/'). Ignored when branch is set. */
  branchPrefix?: string;
  skipValidation?: boolean;
  acceptanceCriteria?: string[];
  outputMode?: OutputMode;
  baseBranch?: string;
  acFrom?: string;
  linkedSessionId?: string;
  /** PIM groups to activate for the duration of this session */
  pimGroups?: PimGroupConfig[];
}

export interface SessionSummary {
  id: string;
  profileName: string;
  task: string;
  status: SessionStatus;
  model: string;
  runtime: RuntimeType;
  duration: number | null;
  filesChanged: number;
  createdAt: string;
}
