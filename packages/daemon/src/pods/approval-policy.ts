import type {
  FactCheckResult,
  OperatorActor,
  TaskSummary,
  ValidationFinding,
  ValidationOverride,
  ValidationResult,
  ValidationWaiver,
} from '@autopod/shared';
import { AutopodError } from '@autopod/shared';
import type { ApprovalReadiness, ApproveSessionOptions } from './approval-contracts.js';
import { failedFactIds, failedValidationPhases } from './validation-workflow-policy.js';
import { WORKSPACE_SYNC_EXCLUDES } from './workspace-mirror.js';

export const APPROVAL_SNAPSHOT_EXCLUDES = [
  ...WORKSPACE_SYNC_EXCLUDES,
  '.pnpm-store',
  '.turbo',
  '.next',
  '.nuxt',
  '.venv',
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
  '.gradle',
];

export function actorLabel(actor: OperatorActor): string {
  if (actor.type === 'human') return actor.displayName?.trim() || actor.userId;
  if (actor.type === 'podsitter') return `Podsitter decision ${actor.decisionId}`;
  return `automation:${actor.id}`;
}

export function legacyRespondedBy(actor: OperatorActor): 'human' | 'ai' {
  return actor.type === 'human' ? 'human' : 'ai';
}

export function buildValidationWaiver(
  result: ValidationResult | null,
  reason: string | undefined,
  actor: OperatorActor,
): ValidationWaiver {
  return {
    waivedAt: new Date().toISOString(),
    waivedBy: actorLabel(actor),
    actor,
    reason: reason?.trim() || 'Approved anyway by operator',
    attempt: result?.attempt ?? null,
    failedPhases: failedValidationPhases(result),
    failedFactIds: failedFactIds(result),
  };
}

export function parseValidationOverrideResponse(
  message: string,
  findings: ValidationFinding[],
): ValidationOverride[] {
  const trimmed = message.trim().toLowerCase();
  const now = new Date().toISOString();

  // "dismiss" or "dismiss all" → dismiss everything
  if (trimmed === 'dismiss' || trimmed === 'dismiss all') {
    return findings.map((f) => ({
      findingId: f.id,
      description: f.description,
      action: 'dismiss' as const,
      reason: message.trim(),
      createdAt: now,
    }));
  }

  // "dismiss 1,2,3" → dismiss specific indices
  const dismissMatch = trimmed.match(/^dismiss\s+([\d,\s]+)$/);
  if (dismissMatch) {
    // biome-ignore lint/style/noNonNullAssertion: dismissMatch[1] is guaranteed by regex capture group
    const indices = dismissMatch[1]!
      .split(/[,\s]+/)
      .map((s) => Number.parseInt(s, 10) - 1) // 1-based → 0-based
      .filter((i) => i >= 0 && i < findings.length);

    const indexSet = new Set(indices);
    return findings
      .filter((_, i) => indexSet.has(i))
      .map((f) => ({
        findingId: f.id,
        description: f.description,
        action: 'dismiss' as const,
        reason: message.trim(),
        createdAt: now,
      }));
  }

  // Anything else → guidance for all findings
  return findings.map((f) => ({
    findingId: f.id,
    description: f.description,
    action: 'guidance' as const,
    guidance: message.trim(),
    createdAt: now,
  }));
}

export function normalizeApprovalReason(reason?: string): string | undefined {
  const trimmed = reason?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

export function readinessSkipReason(
  readiness: Pick<ApprovalReadiness, 'status' | 'summary'>,
): string {
  return readiness.status === 'ready'
    ? 'Readiness Review is ready.'
    : `Readiness Review is ${readiness.status}: ${readiness.summary}`;
}

export function assertApprovalAllowed(
  podId: string,
  readiness: Pick<ApprovalReadiness, 'status' | 'summary'>,
  options: ApproveSessionOptions = {},
): string | undefined {
  const reason = normalizeApprovalReason(options.reason);
  if (options.automation && readiness.status !== 'ready') {
    throw new AutopodError(readinessSkipReason(readiness), 'READINESS_NOT_READY', 409);
  }
  if ((readiness.status === 'risky' || readiness.status === 'waived') && !reason) {
    throw new AutopodError(
      `Approval reason is required for ${readiness.status} Readiness Review on pod ${podId}`,
      'READINESS_REASON_REQUIRED',
      400,
    );
  }
  return reason;
}

export function taskSummaryWithApprovedFactWaiver(
  summary: TaskSummary | null,
  fact: FactCheckResult,
  reason?: string,
  actor: OperatorActor = { type: 'automation', id: 'direct-pod-manager' },
): TaskSummary {
  const existingSummary = summary ?? {
    actualSummary: `${actorLabel(actor)} approved required fact waiver for ${fact.factId}.`,
    deviations: [],
  };
  const existingDeviations = existingSummary.factDeviations ?? [];
  const existing = existingDeviations.find((d) => d.factId === fact.factId);
  const approvalReason = reason?.trim() || existing?.reason || fact.reasoning;
  const whyImpossible = existing?.whyImpossible || fact.reasoning;

  return {
    ...existingSummary,
    factDeviations: [
      ...existingDeviations.filter((d) => d.factId !== fact.factId),
      {
        factId: fact.factId,
        action: 'waive',
        decision: 'approved_waive',
        actor,
        reason: approvalReason,
        whyImpossible,
      },
    ],
  };
}
