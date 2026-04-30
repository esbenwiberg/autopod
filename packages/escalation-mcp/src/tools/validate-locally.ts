import type { PodBridge, ValidationPhaseName, ValidationPhaseResult } from '../pod-bridge.js';

export interface ValidateLocallyInput {
  /**
   * Subset of phases to run. Defaults to all phases the profile has commands
   * for, in the same order the daemon uses (lint → build → tests). Tests are
   * skipped automatically when build runs and fails.
   */
  phases?: ValidationPhaseName[];
}

export interface ValidateLocallyPhaseResult extends ValidationPhaseResult {
  /** True when an earlier phase (build) failed and this phase was skipped. */
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

const DEFAULT_PHASE_ORDER: ValidationPhaseName[] = ['lint', 'build', 'tests'];

export async function validateLocally(
  podId: string,
  input: ValidateLocallyInput,
  bridge: PodBridge,
): Promise<string> {
  const requested = input.phases?.length ? dedupe(input.phases) : DEFAULT_PHASE_ORDER;

  for (const phase of requested) {
    if (!isValidPhase(phase)) {
      throw new Error(`Unknown phase "${phase}". Valid phases: ${DEFAULT_PHASE_ORDER.join(', ')}.`);
    }
  }

  // Run in canonical order regardless of caller-provided order — keeps the
  // build → tests dependency intuitive in the result list.
  const ordered = DEFAULT_PHASE_ORDER.filter((p) => requested.includes(p));

  const results: ValidateLocallyPhaseResult[] = [];
  let buildFailedThisRun = false;

  for (const phase of ordered) {
    if (phase === 'tests' && buildFailedThisRun) {
      results.push({
        phase,
        configured: false,
        passed: false,
        exitCode: null,
        command: null,
        durationMs: 0,
        output: '',
        skipped: true,
        skippedReason:
          'Build failed earlier in this run — tests skipped, same as the daemon pipeline.',
      });
      continue;
    }

    const result = await bridge.runValidationPhase(podId, phase);
    results.push(result);

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

function dedupe<T>(items: T[]): T[] {
  return Array.from(new Set(items));
}
