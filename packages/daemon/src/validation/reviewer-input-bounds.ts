/** Existing hard UTF-8 prompt ceiling for packet-only, isolated reviewers. */
export const MAX_ISOLATED_REVIEW_INPUT_BYTES = 1_000_000;

/** Match the collector's literal LF footer, not JS line separators inside Git hunks. */
export function hasTruncatedReviewDiff(diff: string): boolean {
  return /(?:^|\n)⚠ DIFF TRUNCATED:/.test(diff);
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
