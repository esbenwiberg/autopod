import {
  AutopodError,
  type EffectiveLaunchConfig,
  type EscalationRequest,
  type ExecutionRequirements,
  type PrerequisiteBlockerV1,
  prerequisiteBlockerV1Schema,
  REPAIR_REPORT_BYTES_LIMIT,
  REPAIR_REPORT_LIMIT,
} from '@autopod/shared';
import {
  canonicalConfiguration,
  configurationDigest,
} from '../configuration/configuration-digest.js';

// These names describe unsupported operation/native/credential backends, not ordinary launcher needs.
// This is a conservative refusal, not an inference from free-text descriptions or a capability proof.
const unsupportedLaunchers = new Set([
  'docker',
  'podman',
  'buildah',
  'buildctl',
  'nerdctl',
  'dagger',
  'xcodebuild',
  'xcrun',
  'swift',
  'codesign',
  'security',
  'az',
]);

export function assertRepairableExecutionRequirements(
  requirements: ExecutionRequirements | undefined,
): asserts requirements is Extract<ExecutionRequirements, { version: 2 }> {
  if (
    requirements?.version !== 2 ||
    requirements.requiresImageBuild ||
    requirements.platform?.startsWith('darwin/') ||
    requirements.executables.some(
      (name) =>
        !/^[A-Za-z0-9_][A-Za-z0-9_.+-]{0,255}$/.test(name) || unsupportedLaunchers.has(name),
    )
  )
    throw new AutopodError(
      'Repair supports only explicit v2 launcher lookup needs on Linux; builder, native, credential and path operations remain unqualified.',
      'REPAIR_UNSUPPORTED_NEEDS',
      409,
    );
}

/** Validate a prospective claim, never repair success or permission. No legacy text mapping. */
export function validatePrerequisiteBlocker(
  input: unknown,
  requirements: ExecutionRequirements | undefined,
): PrerequisiteBlockerV1 {
  assertRepairableExecutionRequirements(requirements);
  const parsed = prerequisiteBlockerV1Schema.safeParse(input);
  if (
    !parsed.success ||
    parsed.data.requirementsHash !== configurationDigest(requirements) ||
    parsed.data.launchers.some((name) => !requirements.executables.includes(name))
  )
    throw new AutopodError(
      'Typed blocker must reference only launcher names in the original frozen v2 requirements at their exact hash.',
      'INVALID_PREREQUISITE_BLOCKER',
      400,
    );
  return parsed.data;
}

/** Caller must supply the COMPLETE current original-generation infrastructure set, not a display page.
 * Hash all original payload bytes canonically even when a lastValidationResult exists.
 */
export function inspectRepairPrerequisiteReports(
  reports: readonly EscalationRequest[],
  original: EffectiveLaunchConfig,
  generation: number,
): { requirementsHash: string; reportSetHash: string; launchers: string[] } {
  const requirements = original.work.contract?.executionRequirements;
  assertRepairableExecutionRequirements(requirements);
  if (!reports.length || reports.length > REPAIR_REPORT_LIMIT)
    throw new AutopodError(
      'Complete bounded infrastructure reports required',
      'REPAIR_INCOMPLETE_REPORTS',
      409,
    );
  const ordered = [...reports].sort((a, b) =>
    a.timestamp < b.timestamp
      ? -1
      : a.timestamp > b.timestamp
        ? 1
        : a.id < b.id
          ? -1
          : a.id > b.id
            ? 1
            : 0,
  );
  const ids = new Set<string>();
  const names = new Set<string>();
  let bytes = 0;
  for (const report of ordered) {
    const encoded = canonicalConfiguration(report);
    bytes += Buffer.byteLength(encoded);
    const payload = report.payload;
    if (
      typeof report.id !== 'string' ||
      !report.id ||
      report.id.length > 128 ||
      typeof report.timestamp !== 'string' ||
      !Number.isFinite(Date.parse(report.timestamp)) ||
      report.podId !== ordered[0]?.podId ||
      ids.has(report.id) ||
      Buffer.byteLength(encoded) > 65536 ||
      bytes > REPAIR_REPORT_BYTES_LIMIT ||
      report.type !== 'report_blocker' ||
      !('kind' in payload) ||
      payload.kind !== 'infrastructure' ||
      payload.lifecycleGeneration !== generation ||
      payload.requiresResponse !== false ||
      !['autopod', 'parent', 'validation'].includes(payload.owner ?? '') ||
      typeof payload.phase !== 'string' ||
      !payload.phase.trim() ||
      typeof payload.description !== 'string' ||
      !payload.description.trim() ||
      typeof payload.needs !== 'string' ||
      !payload.needs.trim() ||
      !Array.isArray(payload.attempted) ||
      payload.attempted.some((item) => typeof item !== 'string') ||
      report.response !== null ||
      !payload.prerequisiteBlocker
    )
      throw new AutopodError(
        'Legacy, mixed, incomplete or oversized needs remain unqualified',
        'REPAIR_UNSUPPORTED_NEEDS',
        409,
      );
    ids.add(report.id);
    for (const name of validatePrerequisiteBlocker(payload.prerequisiteBlocker, requirements)
      .launchers)
      names.add(name);
  }
  return {
    requirementsHash: configurationDigest(requirements),
    reportSetHash: configurationDigest(ordered),
    launchers: [...names].sort(),
  };
}
