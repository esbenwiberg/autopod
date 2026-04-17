import type { OutputMode } from './actions.js';

/**
 * How the session is driven.
 *
 * - `auto`        — an AI agent runs the orchestration loop until the task
 *                   reports complete.
 * - `interactive` — the container stays alive with no agent; a human attaches
 *                   and drives it directly. Completion is triggered by
 *                   `completeSession()` (aka `ap complete`).
 */
export type AgentMode = 'auto' | 'interactive';

/**
 * Where the session's output goes.
 *
 * - `pr`       — push the branch and open a pull request. Requires `repoUrl`.
 * - `branch`   — push the branch to origin only, no PR.
 * - `artifact` — extract `/workspace` from the container to the data dir.
 * - `none`     — ephemeral; nothing leaves the container.
 */
export type OutputTarget = 'pr' | 'branch' | 'artifact' | 'none';

/**
 * Orthogonal axes describing what a session is.
 *
 * Replaces the single `OutputMode` enum, which conflated agent presence,
 * output destination, and validation into one value.
 */
export interface PodConfig {
  agentMode: AgentMode;
  output: OutputTarget;
  /**
   * Run the full build/smoke/review pipeline before completing.
   * Defaults: `output='pr'` → true; all others → false.
   */
  validate?: boolean;
  /**
   * Allow this session to be promoted to a different mode later
   * (e.g. interactive → auto via `ap complete --pr`). Default true.
   */
  promotable?: boolean;
}

/**
 * Resolve a full `PodConfig` from the legacy `OutputMode` string.
 * Used by the DB migration backfill and as a compatibility layer for callers
 * that still pass `outputMode`.
 */
export function podConfigFromOutputMode(mode: OutputMode): PodConfig {
  switch (mode) {
    case 'pr':
      return { agentMode: 'auto', output: 'pr', validate: true, promotable: false };
    case 'artifact':
      return { agentMode: 'auto', output: 'artifact', validate: false, promotable: false };
    case 'workspace':
      return { agentMode: 'interactive', output: 'branch', validate: false, promotable: true };
  }
}

/**
 * Derive a legacy `OutputMode` for wire back-compat. The legacy enum can't
 * express the full axis space — e.g. `{interactive, pr}` has no legacy peer —
 * so this returns the closest match.
 */
export function outputModeFromPod(pod: PodConfig): OutputMode {
  if (pod.agentMode === 'interactive') return 'workspace';
  if (pod.output === 'artifact') return 'artifact';
  return 'pr';
}

/**
 * Merge a partial session override onto a profile default, producing a
 * concrete `PodConfig` with all defaults filled in.
 */
export function resolvePodConfig(
  profileDefault: PodConfig | null | undefined,
  override: Partial<PodConfig> | null | undefined,
): PodConfig {
  const base: PodConfig = profileDefault ?? {
    agentMode: 'auto',
    output: 'pr',
    validate: true,
    promotable: false,
  };
  const merged: PodConfig = {
    agentMode: override?.agentMode ?? base.agentMode,
    output: override?.output ?? base.output,
    validate: override?.validate ?? base.validate,
    promotable: override?.promotable ?? base.promotable,
  };
  // Apply axis-implied defaults when validate/promotable weren't explicitly set.
  if (merged.validate === undefined) merged.validate = merged.output === 'pr';
  if (merged.promotable === undefined) merged.promotable = merged.agentMode === 'interactive';
  return merged;
}
