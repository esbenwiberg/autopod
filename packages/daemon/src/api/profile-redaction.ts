import type { Profile, PublicProfile } from '@autopod/shared';

export function redactProfileSecrets(profile: Profile): PublicProfile {
  return {
    ...profile,
    adoPat: null,
    githubPat: null,
    registryPat: null,
    openrouterApiKey: null,
    providerCredentials: profile.providerCredentials
      ? { provider: profile.providerCredentials.provider }
      : null,
    hasAdoPat: profile.adoPat !== null,
    // Legacy GitHub PAT presence is deliberately not part of ordinary profile presentation.
    hasGithubPat: false,
    hasRegistryPat: profile.registryPat !== null,
  };
}
