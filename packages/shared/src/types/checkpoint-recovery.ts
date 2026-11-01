/** Selects preserved Git source for fresh checks; never settles the original execution. */
export interface CheckpointRecoveryRequest {
  id: string;
  expectedGeneration: number;
  expectedResultHash: string;
  checkpointHead: string;
  reason: string;
}
