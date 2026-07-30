import type { ReasoningEffort } from './profile.js';

export type PodsitterRuntime = 'claude' | 'codex' | 'copilot' | 'pi';

export interface PodsitterDecisionTarget {
  providerAccountId: string;
  runtime: PodsitterRuntime;
  model: string;
  reasoningEffort?: ReasoningEffort;
}

export type PodsitterActivation =
  | { mode: 'always' }
  | {
      mode: 'recurring';
      cronExpression: string;
      durationMinutes: number;
      timeZone: string;
    };

export interface PodsitterAuthorization {
  enabled: boolean;
  activation: PodsitterActivation;
  authorizedUntil: string | null;
  generation: number;
  profileScope: string[] | null;
}

export interface PodsitterBudgets {
  maxDecisionsPerWindow: number;
  maxActionsPerWindow: number;
}

export interface PodsitterConfiguration extends PodsitterAuthorization {
  decisionTarget: PodsitterDecisionTarget | null;
  budgets: PodsitterBudgets;
  updatedBy: OperatorActor;
  createdAt: string;
  updatedAt: string;
}

export type OperatorActor =
  | { type: 'human'; userId: string; displayName?: string }
  | { type: 'automation'; id: string }
  | {
      type: 'podsitter';
      decisionId: string;
      providerAccountId: string;
      model: string;
    };

export const PODSITTER_ACTIONS = [
  'no_action',
  'report',
  'approve',
  'reject',
  'tell',
  'nudge',
  'dismiss_validation_finding',
  'guide_validation_fix',
  'extend_budget',
  'kick',
  'interrupt_validation',
  'revalidate',
  'extend_validation_attempts',
  'approve_fact_waiver',
  'extend_pr_attempts',
  'spawn_fix',
  'retry_pr',
  'update_from_base',
  'inject_credential',
  'install_tool',
  'recover_worktree',
  'force_approve',
  'skip_validation',
  'force_complete',
  'fix_manually',
] as const;

export type PodsitterAction = (typeof PODSITTER_ACTIONS)[number];
export type PodsitterConfidence = 'low' | 'medium' | 'high';

export interface PodsitterActionArguments {
  no_action: Record<string, never>;
  report: { message: string };
  approve: Record<string, never>;
  reject: { message: string };
  tell: { message: string };
  nudge: { message: string };
  dismiss_validation_finding: { findingId: string; reason: string };
  guide_validation_fix: { findingId: string; guidance: string };
  extend_budget: Record<string, never>;
  kick: Record<string, never>;
  interrupt_validation: Record<string, never>;
  revalidate: Record<string, never>;
  extend_validation_attempts: Record<string, never>;
  approve_fact_waiver: { factId: string; justification: string };
  extend_pr_attempts: Record<string, never>;
  spawn_fix: Record<string, never>;
  retry_pr: Record<string, never>;
  update_from_base: Record<string, never>;
  inject_credential: { credentialId: string };
  install_tool: { toolName: string };
  recover_worktree: Record<string, never>;
  force_approve: { failedPhases: string[]; manualEvidenceRefs: string[] };
  skip_validation: { failedPhases: string[]; manualEvidenceRefs: string[] };
  force_complete: { failedPhases: string[]; manualEvidenceRefs: string[] };
  fix_manually: { instructions: string };
}

interface PodsitterDecisionCommon {
  contractVersion: 1;
  attentionSignature: string;
  reason: string;
  evidenceRefs: string[];
  confidence: PodsitterConfidence;
  remainingRisk: string;
  stopCondition: string;
}

export type PodsitterDecision = PodsitterDecisionCommon &
  {
    [Action in PodsitterAction]: {
      action: Action;
      arguments: PodsitterActionArguments[Action];
    };
  }[PodsitterAction];

export type PodsitterAttentionState =
  | 'pending'
  | 'deferred'
  | 'deciding'
  | 'acted'
  | 'reported'
  | 'superseded'
  | 'failed';

export interface PodsitterAttention {
  id: string;
  podId: string;
  signature: string;
  state: PodsitterAttentionState;
  failureSignature: string | null;
  decisionId: string | null;
  leaseOwner: string | null;
  leaseVersion: number;
  leaseExpiresAt: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
  supersededAt: string | null;
}

export type PodsitterDecisionOutcome =
  | 'pending'
  | 'completed'
  | 'failed'
  | 'superseded'
  | 'not_executed';

export interface PodsitterDecisionRecord {
  id: string;
  attentionId: string;
  podId: string;
  attentionSignature: string;
  configurationGeneration: number;
  activationWindowId: string;
  evidenceHash: string;
  evidenceVersion: number;
  target: PodsitterDecisionTarget;
  decision: PodsitterDecision | null;
  outcome: PodsitterDecisionOutcome;
  failureCode: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
  createdAt: string;
  completedAt: string | null;
  executedAt: string | null;
}

export type PodsitterProviderCircuitStatus =
  | 'available'
  | 'rate_limited'
  | 'quota_exhausted'
  | 'auth_failed'
  | 'unavailable';

export interface PodsitterProviderState {
  providerAccountId: string;
  status: PodsitterProviderCircuitStatus;
  consecutiveFailures: number;
  retryAt: string | null;
  resetAt: string | null;
  sanitizedReason: string | null;
  probeLeaseOwner: string | null;
  probeLeaseVersion: number;
  probeLeaseExpiresAt: string | null;
  recoveredAt: string | null;
  updatedAt: string;
}

export interface PodsitterActivationEvaluation {
  active: boolean;
  windowId: string | null;
  windowStartedAt: string | null;
  windowEndsAt: string | null;
  reason: 'active' | 'disabled' | 'expired' | 'outside_window';
}

export type SystemSandboxRunOutcome = 'running' | 'completed' | 'failed' | 'cancelled' | 'leaked';
