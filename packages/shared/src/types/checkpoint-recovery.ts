/** Selects preserved Git source for fresh checks; never settles the original execution. */
export interface CheckpointRecoveryRequest {
  id: string;
  expectedGeneration: number;
  expectedResultHash: string;
  checkpointHead: string;
  reason: string;
}

/** Explicit retained-work continuation; never a waiver, retry grant or delivery authority. */
export interface RetainedContinuationRequest extends CheckpointRecoveryRequest {
  /** Select this exact current published branch tip in an independent checkout. */
  remoteHead?: string;
  /** Leave the independent repair checkout prepared until a human selects its final commit. */
  prepareOnly?: boolean;
  /** Explicitly previewed software/resources; repository, AI, workflow and network remain frozen. */
  executionProfileId?: string;
  expectedExecutionDigest?: string;
}

export interface RetainedContinuationCheckRequest {
  /** One source-bound outer-test allowance; never retry permission or a workflow edit. */
  testBudget?: { seconds: number; reason: string };
  expectedGeneration: number;
  expectedResultHash: string;
  candidateHead: string;
  /** One explicit software/resource selection, only if preparation did not select it. */
  executionProfileId?: string;
  expectedExecutionDigest?: string;
  reason: string;
}

/** Human-bound preservation, one-shot quiescence and independently provisioned successor. */
export interface InfrastructureRecoveryRequest extends CheckpointRecoveryRequest {
  mode: 'checks' | 'rework';
  /** Operator diagnosis/qualification, not a passing execution receipt or waiver. */
  qualification: string;
  /** Explicit credential-free repair context; hash binds the exact UTF-8 bytes. */
  instructions?: { content: string; sha256: string };
  executionProfileId?: string;
  expectedExecutionDigest?: string;
}

/** Repair remains owned by the exact failed approval rewrite; no task/config amendment. */
export interface ApprovalRewriteRepairRequest extends CheckpointRecoveryRequest {
  rewriteId: string;
  failedDispatchId: string;
}
export interface ApprovalRewriteRepairCheckRequest {
  rewriteId: string;
  failedDispatchId: string;
  expectedGeneration: number;
  expectedResultHash: string;
  candidateHead: string;
  reason: string;
}
