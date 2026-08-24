import type { Profile, PublicProfile } from '@autopod/shared';

export function redactProfileSecrets(profile: Profile): PublicProfile {
  const legacy = profile as Profile & {
    adoPat?: string | null;
    adoPatExpiresAt?: string | null;
    hasAdoPat?: boolean;
  };
  const {
    adoPat: _adoPat,
    adoPatExpiresAt: _adoPatExpiresAt,
    hasAdoPat: _hasAdoPat,
    ...safeProfile
  } = legacy;
  return {
    ...safeProfile,
    githubPat: null,
    registryPat: null,
    openrouterApiKey: null,
    providerCredentials: profile.providerCredentials
      ? { provider: profile.providerCredentials.provider }
      : null,
    // Legacy GitHub PAT presence is deliberately not part of ordinary profile presentation.
    hasGithubPat: false,
    hasRegistryPat: profile.registryPat !== null,
  };
}
