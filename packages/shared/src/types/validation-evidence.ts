/** Internal evidence identity; incomplete or non-hermetic environments are never reusable. */
export interface ValidationInputIdentity {
  version: 1;
  hermetic: boolean;
  sourceTree: string;
  contract: string;
  toolchain: string;
  commands: string;
  dependencies: string;
  environment: string;
  implementation: string;
}
export interface ReusedValidationEvidence {
  receiptId: string;
  identityHash: string;
  originalPodId: string;
  originalExecutedAt: string;
  originalDurationMs: number;
}
