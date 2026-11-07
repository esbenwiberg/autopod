import type { EffectiveLaunchConfig } from '@autopod/shared';
import { configurationError } from './configuration-store.js';

/** Static comparison only: declarations never qualify an actual operation or validation result. */
export function assertLaunchRequirements(config: EffectiveLaunchConfig): void {
  const requirements = config.work.contract?.executionRequirements;
  if (requirements?.version !== 2) return;
  if (requirements.requiresImageBuild)
    configurationError(
      'Image-build operations are not qualified for workers. Select an explicitly supported task/environment contract before launching; Docker CLI presence, daemon connectivity and capability labels are not build-operation proof.',
      'EXECUTION_IMAGE_BUILD_UNSUPPORTED',
      409,
    );
  if (requirements.platform && requirements.platform !== config.resolvedEnvironment.platform)
    configurationError(
      `Required worker platform ${requirements.platform} does not match the resolved environment ${config.resolvedEnvironment.platform}. Select a compatible environment; local Docker is not a native Mac worker or macOS validation proof.`,
      'EXECUTION_PLATFORM_MISMATCH',
      409,
    );
  for (const required of requirements.requiredReferenceRepositories ?? []) {
    // Every binding for this ID must agree: do not let an ambiguous duplicate qualify the input.
    const selected = config.references.filter(
      (reference) => reference.id === required.repositoryId,
    );
    if (!selected.length)
      configurationError(
        `Required reference repository ${required.repositoryId} at ${required.commitSha} is missing. Select the enrolled read-only reference at that exact revision.`,
        'EXECUTION_REFERENCE_MISSING',
        409,
      );
    if (selected.some((reference) => reference.revision !== required.commitSha))
      configurationError(
        `Required reference repository ${required.repositoryId} does not match exact revision ${required.commitSha}. Review and select that revision before launching.`,
        'EXECUTION_REFERENCE_MISMATCH',
        409,
      );
  }
}
