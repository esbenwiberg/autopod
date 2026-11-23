/** Verified report bytes captured during workspace preservation, not a findings receipt. */
export interface PartialResearchReport {
  path: 'research-output.md';
  content: string;
  size: number;
  status: 'incomplete_unreviewed';
  provenance: {
    podId: string;
    generation: number;
    cycle: number;
    agentSettledAt: string;
    capturedAt: string;
    sha256: string;
  };
}
