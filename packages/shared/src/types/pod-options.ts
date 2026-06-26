import type { OutputMode } from './actions.js';
import type { ValidationPhase } from './events.js';

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
 * Which validation phases Autopod runs before handing work to the PR workflow.
 *
 * Repo-owned GitHub checks remain independent from this setting: a pod may run
 * thin Autopod validation while the PR or main workflow runs a fuller suite.
 */
export type ValidationSuite =
  | 'off'
  | 'thin'
  | 'thin-with-facts'
  | 'deterministic'
  | 'full'
  | 'custom';

export const VALIDATION_SUITES: readonly ValidationSuite[] = [
  'off',
  'thin',
  'thin-with-facts',
  'deterministic',
  'full',
  'custom',
] as const;

const ALL_VALIDATION_PHASES: readonly ValidationPhase[] = [
  'setup',
  'lint',
  'sast',
  'build',
  'test',
  'health',
  'pages',
  'facts',
  'review',
  'advisory',
] as const;

const VALIDATION_SUITE_SKIPS: Record<ValidationSuite, readonly ValidationPhase[]> = {
  off: ALL_VALIDATION_PHASES,
  // Fast pre-PR confidence: no SAST/page smoke/facts/AI/advisory.
  thin: ['sast', 'pages', 'facts', 'review', 'advisory'],
  // Same thin deterministic path, plus contract facts.
  'thin-with-facts': ['sast', 'pages', 'review', 'advisory'],
  // Full deterministic signal, but no model review or advisory browser QA.
  deterministic: ['review', 'advisory'],
  full: [],
  // Custom means profile.skipValidationPhases is the source of truth.
  custom: [],
};

export function isValidationSuite(value: string): value is ValidationSuite {
  return (VALIDATION_SUITES as readonly string[]).includes(value);
}

export function skippedPhasesForValidationSuite(suite: ValidationSuite): ValidationPhase[] {
  return [...VALIDATION_SUITE_SKIPS[suite]];
}

export function mergeValidationPhaseSkips(
  suite: ValidationSuite,
  extraSkips: readonly ValidationPhase[] | null | undefined,
): ValidationPhase[] {
  return Array.from(new Set([...skippedPhasesForValidationSuite(suite), ...(extraSkips ?? [])]));
}

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
   * Validation suite to run before the PR handoff. Undefined preserves legacy
   * defaults (`validate=true` => `full`, `validate=false` => `off`).
   */
  validationSuite?: ValidationSuite;
  /**
   * Per-pod override for advisory browser QA. Undefined inherits the resolved
   * profile default. This produces evidence only and does not affect validation
   * pass/fail.
   */
  advisoryBrowserQaEnabled?: boolean;
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
      return {
        agentMode: 'auto',
        output: 'pr',
        validate: true,
        validationSuite: 'full',
        promotable: false,
      };
    case 'artifact':
      return {
        agentMode: 'auto',
        output: 'artifact',
        validate: false,
        validationSuite: 'off',
        promotable: false,
      };
    case 'workspace':
      return {
        agentMode: 'interactive',
        output: 'branch',
        validate: false,
        validationSuite: 'off',
        promotable: true,
      };
  }
}

/**
 * Derive a legacy `OutputMode` for wire back-compat. The legacy enum can't
 * express the full axis space, so this is **lossy** — e.g. both `{interactive,
 * branch}` and `{interactive, artifact}` collapse to `'workspace'`. Anything
 * reading this back through `podOptionsFromOutputMode()` will see the
 * non-artifact variant, which historically surfaced as a wrong `INT·BR` badge
 * on interactive-artifact pods (see the `pods` table: `output_target` is the
 * authoritative column; `output_mode` is kept only to not break older readers).
 *
 * **Deprecated for new call sites** — write/read `PodOptions` directly.
 * This helper exists only to keep the legacy `output_mode` DB column in sync
 * on insert and for older API clients that still key off the string.
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
    validationSuite: 'full',
    promotable: false,
  };
  const merged: PodOptions = {
    agentMode: override?.agentMode ?? base.agentMode,
    output: override?.output ?? base.output,
    validate: override?.validate ?? base.validate,
    validationSuite: override?.validationSuite ?? base.validationSuite,
    advisoryBrowserQaEnabled: override?.advisoryBrowserQaEnabled ?? base.advisoryBrowserQaEnabled,
    promotable: override?.promotable ?? base.promotable,
  };
  // Apply axis-implied defaults when validate/promotable weren't explicitly set.
  if (merged.validate === undefined) merged.validate = merged.output === 'pr';
  if (merged.validationSuite === undefined) {
    merged.validationSuite = merged.validate ? 'full' : 'off';
  }
  if (override?.validate === true && override.validationSuite === undefined) {
    merged.validationSuite = merged.validationSuite === 'off' ? 'full' : merged.validationSuite;
  }
  if (override?.validate === false && override.validationSuite === undefined) {
    merged.validationSuite = 'off';
  }
  if (override?.validationSuite !== undefined) {
    merged.validate = override.validationSuite !== 'off';
  }
  if (merged.validationSuite !== 'off') merged.validate = true;
  if (merged.validationSuite === 'off') merged.validate = false;
  if (merged.promotable === undefined) merged.promotable = merged.agentMode === 'interactive';
  return merged;
}
