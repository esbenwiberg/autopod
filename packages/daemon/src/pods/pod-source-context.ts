import { AutopodError, type EffectiveLaunchConfig, type Pod } from '@autopod/shared';

export interface PodSourceContext {
  repoUrl: string | null;
  defaultBranch: string | null;
}

/** Repository identity comes from the admitted snapshot even after definitions are archived. */
export function podSourceContext(
  pod: Pick<Pod, 'id' | 'launchConfigDigest' | 'profileName' | 'profileSnapshot'>,
  readLaunch: ((podId: string) => EffectiveLaunchConfig | null) | undefined,
  readLegacy: (name: string) => PodSourceContext,
): PodSourceContext {
  if (pod.launchConfigDigest) {
    const launch = readLaunch?.(pod.id);
    if (!launch || launch.digest !== pod.launchConfigDigest)
      throw new AutopodError(
        'Immutable repository identity is unavailable',
        'SNAPSHOT_CORRUPT',
        500,
      );
    return {
      repoUrl: launch.repository?.config.remote ?? null,
      defaultBranch: launch.repository?.setup.defaultBranch ?? null,
    };
  }
  if (pod.profileSnapshot) return pod.profileSnapshot;
  try {
    return readLegacy(pod.profileName);
  } catch {
    return { repoUrl: null, defaultBranch: null };
  }
}
