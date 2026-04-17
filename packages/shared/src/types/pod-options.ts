import type { OutputMode } from './actions.js';

/**
 * How the pod is driven.
 *
 * - `auto`        — an AI agent runs the orchestration loop until the task
 *                   reports complete.
 * - `interactive` — the container stays alive with no agent; a human attaches
 *                   and drives it directly. Completion is triggered by
 *                   `completePod()` (aka `ap complete`).
 */
export type AgentMode = 'auto' | 'interactive';

/**
 * Where the pod's output goes.
 *
 * - `pr`       — push the branch and open a pull request. Requires `repoUrl`.
 * - `branch`   — push the branch to origin only, no PR.
 * - `artifact` — extract `/workspace` from the container to the data dir.
 * - `none`     — ephemeral; nothing leaves the container.
 */
export type OutputTarget = 'pr' | 'branch' | 'artifact' | 'none';

/**
 * Orthogonal axes describing what a pod is.
 *
 * Replaces the single `OutputMode` enum, which conflated agent presence,
 * output destination, and validation into one value.
 */
export interface PodOptions {
  agentMode: AgentMode;
  output: OutputTarget;
  /**
   * Run the full build/smoke/review pipeline before completing.
   * Defaults: `output='pr'` → true; all others → false.
   */
  validate?: boolean;
  /**
   * Allow this pod to be promoted to a different mode later
   * (e.g. interactive → auto via `ap complete --pr`). Default true.
   */
  promotable?: boolean;
}

/**
 * Resolve a full `PodOptions` from the legacy `OutputMode` string.
 * Used by the DB migration backfill and as a compatibility layer for callers
 * that still pass `outputMode`.
 */
export function podOptionsFromOutputMode(mode: OutputMode): PodOptions {
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
export function outputModeFromPodOptions(options: PodOptions): OutputMode {
  if (options.agentMode === 'interactive') return 'workspace';
  if (options.output === 'artifact') return 'artifact';
  return 'pr';
}

/**
 * Merge a partial pod override onto a profile default, producing a
 * concrete `PodOptions` with all defaults filled in.
 */
export function resolvePodOptions(
  profileDefault: PodOptions | null | undefined,
  override: Partial<PodOptions> | null | undefined,
): PodOptions {
  const base: PodOptions = profileDefault ?? {
    agentMode: 'auto',
    output: 'pr',
    validate: true,
    promotable: false,
  };
  const merged: PodOptions = {
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
