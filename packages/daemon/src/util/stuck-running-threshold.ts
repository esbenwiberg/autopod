/** Default silence after which the stuck-pod watchdog fails a `running` pod. */
export const DEFAULT_STUCK_RUNNING_THRESHOLD_MS = 30 * 60 * 1_000;

/**
 * Silence threshold of the stuck-pod watchdog (`AUTOPOD_STUCK_RUNNING_THRESHOLD_MS`).
 * Shared so runtime waits that are silent by design (for example Claude's bounded
 * background-task wait) can stay below it whatever the operator configures.
 */
export function resolveStuckRunningThresholdMs(
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = env.AUTOPOD_STUCK_RUNNING_THRESHOLD_MS;
  if (!raw) return DEFAULT_STUCK_RUNNING_THRESHOLD_MS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_STUCK_RUNNING_THRESHOLD_MS;
}
