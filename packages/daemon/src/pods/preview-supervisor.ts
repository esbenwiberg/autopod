/**
 * Pure helpers for the per-pod dev-server supervisor.
 *
 * The supervisor is a shell wrapper that respawns the dev server on crash.
 * It lives in the per-pod container as a PID-tracked background process.
 * This module only builds strings and parses strings — all actual I/O
 * (execInContainer, fetch) is the caller's responsibility.
 */

export interface PreviewStatus {
  /** Supervisor PID is alive (false when no supervisor is running). */
  running: boolean;
  /** Last reachability probe returned 2xx. */
  reachable: boolean;
  /** Total respawns since the supervisor started. */
  restartCount: number;
  /** Last non-empty line from /tmp/autopod-start.log (null when none). */
  lastError: string | null;
}

/**
 * Build the shell command that wraps `startCommand` in a never-give-up
 * supervisor. The produced string is intended for `sh -c` inside the container.
 *
 * State files written by the supervisor:
 *   /tmp/autopod-supervisor.pid  — outer subshell PID
 *   /tmp/autopod-restart-count   — incremented on each crash/restart
 *   /tmp/autopod-start.log       — stdout+stderr of the wrapped command
 */
export function buildSupervisorCommand(startCommand: string): string {
  // Escape single quotes inside startCommand for safe shell embedding.
  const escaped = startCommand.replace(/'/g, "'\\''");
  return `export START_COMMAND='${escaped}'\ni=0\nrm -f /tmp/autopod-supervisor.pid /tmp/autopod-restart-count /tmp/autopod-start.log\necho 0 > /tmp/autopod-restart-count\n(\n  while true; do\n    eval "$START_COMMAND" >> /tmp/autopod-start.log 2>&1 || true\n    i=$((i+1))\n    echo $i > /tmp/autopod-restart-count\n    if [ $i -ge 5 ]; then sleep 5; else sleep 1; fi\n  done\n) &\necho $! > /tmp/autopod-supervisor.pid`;
}

/**
 * Parse the multi-file status read from /tmp/autopod-* into a PreviewStatus.
 *
 * @param pid          Content of /tmp/autopod-supervisor.pid, or null if absent
 *                     or if the process is confirmed dead (caller should pass
 *                     null when a kill -0 check fails).
 * @param restartCount Content of /tmp/autopod-restart-count, or null if absent.
 * @param startLogTail Last ~200 chars of /tmp/autopod-start.log, or null.
 * @param reachableHttp HTTP status code from a probe of previewUrl, or null on error.
 */
export function parseStatus(input: {
  pid: string | null;
  restartCount: string | null;
  startLogTail: string | null;
  reachableHttp: number | null;
}): PreviewStatus {
  const running = input.pid !== null && input.pid.trim().length > 0;
  const reachable =
    running &&
    input.reachableHttp !== null &&
    input.reachableHttp >= 200 &&
    input.reachableHttp < 300;
  const restartCount =
    input.restartCount !== null ? Number.parseInt(input.restartCount.trim(), 10) || 0 : 0;
  const lastError = extractLastError(input.startLogTail);
  return { running, reachable, restartCount, lastError };
}

function extractLastError(logTail: string | null): string | null {
  if (!logTail) return null;
  const lines = logTail
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  return lines.length > 0 ? (lines[lines.length - 1] ?? null) : null;
}
