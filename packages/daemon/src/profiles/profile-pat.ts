import type { Profile } from '@autopod/shared';

/**
 * Pick the profile PAT for a git operation against `profile.repoUrl`.
 *
 * GitHub is intentionally absent here: GitHub operations are authorized by the
 * daemon service account's `gh` authentication, not profile `githubPat`. The
 * legacy `githubPat` field may still exist for rolling compatibility, but it
 * must not become an operational fallback.
 *
 * ADO behavior is unchanged and still uses the profile ADO PAT.
 */
export function selectGitPat(profile: Profile): string | undefined {
  if (profile.prProvider === 'ado') return profile.adoPat ?? undefined;
  return profile.adoPat ?? undefined;
}
