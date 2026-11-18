import type { PodProfileDisplay } from '@autopod/shared';

/** profileName is a legacy identity key; new daemons provide a captured label separately. */
export function formatPodProfile(pod: {
  profileName: string;
  profileDisplay?: PodProfileDisplay;
}): string {
  const profile = pod.profileDisplay;
  if (!profile) return pod.profileName;
  const label = profile.name ?? 'Unavailable profile';
  return profile.state === 'archived' || profile.state === 'deleted'
    ? `${label} (${profile.state})`
    : label;
}
