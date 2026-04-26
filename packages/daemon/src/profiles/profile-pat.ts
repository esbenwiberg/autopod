import type { Profile } from '@autopod/shared';

/**
 * Pick the PAT for a git operation against `profile.repoUrl`.
 *
 * Routes off `prProvider` because that field is the configured intent — using
 * `adoPat ?? githubPat` instead picks the ADO PAT for any profile that has both,
 * which GitHub rejects with "Invalid username or token. Password authentication
 * is not supported for Git operations." when the repo is hosted on GitHub.
 *
 * When `prProvider` is null (older profiles, partially-configured ones), prefer
 * the GitHub PAT — most repos this daemon handles are GitHub, and an ADO PAT
 * sent to GitHub fails harder than a GitHub PAT sent to ADO.
 */
export function selectGitPat(profile: Profile): string | undefined {
  if (profile.prProvider === 'ado') return profile.adoPat ?? undefined;
  if (profile.prProvider === 'github') return profile.githubPat ?? undefined;
  return profile.githubPat ?? profile.adoPat ?? undefined;
}
