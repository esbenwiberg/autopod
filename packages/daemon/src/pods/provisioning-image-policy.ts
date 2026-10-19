import type { ExecutionTarget } from '@autopod/shared';
import { AutopodError } from '@autopod/shared';
import { getBaseImage } from '../images/dockerfile-generator.js';
import type { PodExecutionSettings } from '../interfaces/pod-execution-settings.js';

export function resolvePodSpawnImage(
  profile: PodExecutionSettings,
  template: string,
  executionTarget: ExecutionTarget,
): string {
  if (executionTarget !== 'sandbox') {
    return profile.warmImageTag ?? getBaseImage(template);
  }

  if (!profile.warmImageTag) {
    throw new AutopodError(
      `Sandbox execution for profile "${profile.name}" requires a warm image. Run \`ap profile warm <profile> --rebuild\` with ACR_REGISTRY_URL configured first.`,
      'SANDBOX_WARM_IMAGE_REQUIRED',
      400,
    );
  }

  if (!isAcrQualifiedImage(profile.warmImageTag)) {
    throw new AutopodError(
      `Sandbox warm image for profile "${profile.name}" must be an ACR-qualified image tag, got "${profile.warmImageTag}". Rebuild the warm image with ACR_REGISTRY_URL so profile.warmImageTag is stored as <registry>.azurecr.io/...`,
      'SANDBOX_WARM_IMAGE_REQUIRED',
      400,
    );
  }

  return profile.warmImageTag;
}

export function isAcrQualifiedImage(image: string): boolean {
  const [registry = ''] = image.split('/');
  return image.includes('/') && registry.endsWith('.azurecr.io');
}

export async function verifySandboxWarmImageAccess(
  profile: PodExecutionSettings,
  image: string,
  warmImageExists?: (tag: string) => Promise<boolean>,
): Promise<void> {
  if (!warmImageExists) return;

  let exists = false;
  try {
    exists = await warmImageExists(image);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new AutopodError(
      `Could not verify sandbox warm image "${image}" for profile "${profile.name}" in ACR: ${detail}`,
      'SANDBOX_WARM_IMAGE_INACCESSIBLE',
      400,
    );
  }

  if (!exists) {
    throw new AutopodError(
      `Sandbox warm image "${image}" for profile "${profile.name}" was not found in the configured ACR or is not accessible to the daemon identity.`,
      'SANDBOX_WARM_IMAGE_INACCESSIBLE',
      400,
    );
  }
}
