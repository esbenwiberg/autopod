/** Identity supplied by the actual container CLI launch path, never by a provider response. */
export interface ReviewerLaunchIdentity {
  podId: string;
  containerId: string;
  runtime: 'claude' | 'codex';
  model: string;
}

/** Probe asynchronously, then recheck synchronously immediately before dispatch. */
export type BeforeReviewerLaunch = (identity: ReviewerLaunchIdentity) => Promise<() => void>;
