/** Selects preserved Git source for fresh checks; never settles the original execution. */
export interface CheckpointRecoveryRequest {
  id: string;
  expectedGeneration: number;
  expectedResultHash: string;
  checkpointHead: string;
  reason: string;
  /** Correct setup for this fresh checks generation; original presets remain immutable. */
  setupCommand?: string;
  /** Resolve only the named failed transport-blocked outcome; never executes checks. */
  resolveFailureOf?: string;
}
