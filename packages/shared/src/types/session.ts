import type { EscalationRequest } from './escalation.js';
import type { RuntimeType } from './runtime.js';
import type { ExecutionTarget } from './profile.js';
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
}

export interface CreateSessionRequest {
  profileName: string;
  task: string;
  model?: string;
  runtime?: RuntimeType;
  executionTarget?: ExecutionTarget;
  branch?: string;
  skipValidation?: boolean;
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
