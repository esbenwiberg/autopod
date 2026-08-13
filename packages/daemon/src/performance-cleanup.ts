/**
 * Drops fetch/undici Resource Timing entries that the daemon does not consume.
 * User Timing is process-global too, but belongs to callers such as Secretlint.
 */
export function clearUnusedResourceTimings(
  performance: Performance = globalThis.performance,
): void {
  performance.clearResourceTimings();
}
