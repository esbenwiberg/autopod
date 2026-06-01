import type { PodBridge, ValidationPhaseName, ValidationPhaseResult } from '../pod-bridge.js';

export interface ValidateLocallyInput {
  /**
   * Subset of phases to run. Defaults to all phases the profile has commands
   * for, in the same order the daemon uses (setup -> lint -> build -> tests).
   * Setup is prepended to downstream requests when configured. Tests are
   * skipped automatically when build runs and fails.
   */
  phases?: ValidationPhaseName[];
}

export interface ValidateLocallyPhaseResult extends ValidationPhaseResult {
  /** True when an earlier phase (setup or build) failed and this phase was skipped. */
  skipped?: boolean;
  skippedReason?: string;
}

export interface ValidateLocallyResult {
  /**
   * True when every requested-and-configured phase passed. False when any
   * phase failed or was skipped due to an upstream failure. Phases that the
   * profile has no command for are ignored.
   */
  passed: boolean;
  results: ValidateLocallyPhaseResult[];
}

const DEFAULT_PHASE_ORDER: ValidationPhaseName[] = ['setup', 'lint', 'build', 'tests'];

export async function validateLocally(
  podId: string,
  input: ValidateLocallyInput,
  bridge: PodBridge,
): Promise<string> {
  const requested = input.phases?.length
    ? ensureSetupFirst(dedupe(input.phases))
    : DEFAULT_PHASE_ORDER;

  for (const phase of requested) {
    if (!isValidPhase(phase)) {
      throw new Error(`Unknown phase "${phase}". Valid phases: ${DEFAULT_PHASE_ORDER.join(', ')}.`);
    }
  }

  // Run in canonical order regardless of caller-provided order. Setup is always
  // considered first so profile tooling is prepared before downstream phases.
  const ordered = DEFAULT_PHASE_ORDER.filter((p) => requested.includes(p));

  const results: ValidateLocallyPhaseResult[] = [];
  let setupFailedThisRun = false;
  let buildFailedThisRun = false;

  for (const phase of ordered) {
    if (phase !== 'setup' && setupFailedThisRun) {
      results.push(
        skippedPhase(phase, 'Setup failed earlier in this run; downstream phases skipped.'),
      );
      continue;
    }

    if (phase === 'tests' && buildFailedThisRun) {
      results.push(
        skippedPhase(
          phase,
          'Build failed earlier in this run; tests skipped, same as the daemon pipeline.',
        ),
      );
      continue;
    }

    const result = await bridge.runValidationPhase(podId, phase);
    results.push(result);

    if (phase === 'setup' && result.configured && !result.passed) {
      setupFailedThisRun = true;
    }

    if (phase === 'build' && result.configured && !result.passed) {
      buildFailedThisRun = true;
    }
  }

  const ranAny = results.some((r) => r.configured && !r.skipped);
  const passed = ranAny && results.every((r) => !r.configured || (!r.skipped && r.passed));

  const response: ValidateLocallyResult = { passed, results };
  return JSON.stringify(response, null, 2);
}

function isValidPhase(phase: string): phase is ValidationPhaseName {
  return DEFAULT_PHASE_ORDER.includes(phase as ValidationPhaseName);
}

function ensureSetupFirst(requested: ValidationPhaseName[]): ValidationPhaseName[] {
  return ['setup', ...requested.filter((phase) => phase !== 'setup')];
}

function skippedPhase(
  phase: ValidationPhaseName,
  skippedReason: string,
): ValidateLocallyPhaseResult {
  return {
    phase,
    configured: false,
    passed: false,
    exitCode: null,
    command: null,
    durationMs: 0,
    output: '',
    skipped: true,
    skippedReason,
  };
}

function dedupe<T>(items: T[]): T[] {
  return Array.from(new Set(items));
}
