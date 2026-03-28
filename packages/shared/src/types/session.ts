import type { OutputMode } from './actions.js';
import type { EscalationRequest } from './escalation.js';
import type { ExecutionTarget } from './profile.js';
import type { RuntimeType } from './runtime.js';
import type { ValidationResult } from './validation.js';

export type SessionStatus =
  | 'queued'
  | 'provisioning'
  | 'running'
  | 'awaiting_input'
  | 'validating'
  | 'validated'
  | 'failed'
  | 'approved'
  | 'merging'
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
  lastHeartbeatAt: string | null;
}

export interface CreateSessionRequest {
  profileName: string;
  task: string;
  model?: string;
  runtime?: RuntimeType;
  executionTarget?: ExecutionTarget;
  branch?: string;
  skipValidation?: boolean;
  acceptanceCriteria?: string[];
  outputMode?: OutputMode;
  baseBranch?: string;
  acFrom?: string;
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
