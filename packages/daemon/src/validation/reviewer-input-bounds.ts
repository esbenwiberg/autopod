/** Existing hard UTF-8 prompt ceiling for packet-only, isolated reviewers. */
export const MAX_ISOLATED_REVIEW_INPUT_BYTES = 1_000_000;

/** Git hunk lines have a prefix; a quoted warning in changed code is not a footer. */
export function hasTruncatedReviewDiff(diff: string): boolean {
  return /^⚠ DIFF TRUNCATED:/m.test(diff);
}

/**
 * Bound launches cannot recover omitted code with workspace tools. Ask the diff
 * collector for up to the existing packet ceiling instead of its smaller UI /
 * legacy-tool-review default. The collector measures characters; the review
 * gate and executor separately enforce UTF-8 bytes and never trim to fit.
 */
export function isolatedReviewDiffLimit(launchConfigDigest: string | null | undefined) {
  return launchConfigDigest ? MAX_ISOLATED_REVIEW_INPUT_BYTES : undefined;
}
