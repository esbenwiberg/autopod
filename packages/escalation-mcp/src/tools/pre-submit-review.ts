import type { PodBridge, PreSubmitReviewInput, PreSubmitReviewToolResult } from '../pod-bridge.js';

export async function preSubmitReview(
  podId: string,
  input: PreSubmitReviewInput,
  bridge: PodBridge,
): Promise<string> {
  const result = await bridge.runPreSubmitReview(podId, input);
  return JSON.stringify(formatForAgent(result), null, 2);
}

/**
 * The bridge result is already structured. We just clean it up for display
 * so the agent sees a focused summary instead of internal-only fields.
 *
 * `filesReviewed` / `linesAdded` / `linesRemoved` are echoed so the agent has
 * a ground-truth anchor for the diff that was reviewed — if those numbers
 * disagree with what the agent expects, the worktree state is the issue, not
 * the verdict.
 */
function formatForAgent(result: PreSubmitReviewToolResult): {
  status: PreSubmitReviewToolResult['status'];
  reasoning: string;
  issues: string[];
  skipReason?: string;
  model: string;
  durationMs: number;
  filesReviewed: number;
  linesAdded: number;
  linesRemoved: number;
  reusedCache?: boolean;
} {
  return {
    status: result.status,
    reasoning: result.reasoning,
    issues: result.issues,
    ...(result.skipReason ? { skipReason: result.skipReason } : {}),
    model: result.model,
    durationMs: result.durationMs,
    filesReviewed: result.filesReviewed,
    linesAdded: result.linesAdded,
    linesRemoved: result.linesRemoved,
    ...(result.reusedCache ? { reusedCache: true } : {}),
  };
}
