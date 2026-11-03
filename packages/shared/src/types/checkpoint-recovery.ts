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
  expectedGeneration: number;
  expectedResultHash: string;
  candidateHead: string;
  /** One explicit software/resource selection, only if preparation did not select it. */
  executionProfileId?: string;
  expectedExecutionDigest?: string;
  reason: string;
}
