import { z } from 'zod';

export const reviewerBudgetRevisionRequestSchema = z
  .object({
    requestId: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/),
    expectedGeneration: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    expectedLimit: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    expectedEvidenceHash: z.string().regex(/^[a-f0-9]{64}$/),
    limit: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    reason: z.string().trim().min(10).max(2000),
    acknowledgement: z.literal('increase-only-usage-retained'),
  })
  .strict();
export type ReviewerBudgetRevisionRequest = z.infer<typeof reviewerBudgetRevisionRequestSchema>;

export interface ReviewerBudgetEvidence {
  podId: string;
  generation: number;
  authorityHash: string;
  limit: number | null;
  revisionId: number | null;
  runs: Array<{
    id: string;
    state: string;
    cleanup: string;
    inputTokens: number | null;
    outputTokens: number | null;
    reconciledAt: string | null;
    usageBasis: string | null;
    reconciledBy: string | null;
    reconciliationNote: string | null;
    failureKind: string | null;
    runtime: string;
    model: string;
    createdAt: string;
    updatedAt: string;
    budgetRevisionId: number | null;
    pending: number;
  }>;
}

export interface ReviewerBudgetRevision {
  id: number;
  podId: string;
  requestId: string;
  authorityHash: string;
  generation: number;
  frozenLimit: number;
  previousLimit: number;
  limit: number;
  recordedTokens: number;
  evidenceHash: string;
  evidence: ReviewerBudgetEvidence;
  actorId: string;
  reason: string;
  createdAt: string;
}
export interface ReviewerBudgetView {
  podId: string;
  generation: number;
  frozenLimit: number | null;
  effectiveLimit: number | null;
  recordedTokens: number;
  pendingRunCount: number;
  unknownUsageRunCount: number;
  operatorReportedUsageRunCount: number;
  evidence: ReviewerBudgetEvidence;
  evidenceHash: string;
  revision: ReviewerBudgetRevision | null;
}
