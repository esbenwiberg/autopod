/** Exact saved selection. Acknowledgement is never a passing-check receipt. */
export interface ArtifactChecksRecoveryRequest {
  id: string;
  expectedBindingHash: string;
  reason: string;
}
