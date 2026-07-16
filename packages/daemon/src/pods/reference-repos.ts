import type { ReferenceRepo } from '@autopod/shared';
import type { Logger } from 'pino';
import type { DaemonGitHubAuth } from '../github/daemon-github-auth.js';
import type { ProfileStore } from '../profiles/profile-store.js';

function deriveMountName(url: string): string {
  const last = url
    .replace(/\.git$/, '')
    .replace(/\/+$/, '')
    .split('/')
    .pop();
  return last && last.length > 0 ? last : url;
}

export function deriveReferenceRepos(
  requested: ReadonlyArray<{ url: string; sourceProfile?: string }> | undefined | null,
): ReferenceRepo[] {
  if (!requested?.length) return [];
  const used = new Set<string>();
  const result: ReferenceRepo[] = [];
  for (const r of requested) {
    const base = deriveMountName(r.url);
    let mountPath = base;
    let suffix = 2;
    while (used.has(mountPath)) {
      mountPath = `${base}-${suffix}`;
      suffix++;
    }
    used.add(mountPath);
    const entry: ReferenceRepo = { url: r.url, mountPath };
    if (r.sourceProfile) entry.sourceProfile = r.sourceProfile;
    result.push(entry);
  }
  return result;
}

/**
 * Resolve the explicit credential for cloning a profile-selected reference
 * repo. GitHub uses the daemon identity; ADO continues to use the profile PAT.
 * Ad-hoc URLs remain unauthenticated and may use public/SSH access.
 */
export async function resolveRefRepoPat(
  repo: ReferenceRepo,
  profileStore: Pick<ProfileStore, 'get'>,
  githubAuth?: DaemonGitHubAuth,
  logger?: Pick<Logger, 'warn'>,
): Promise<string | undefined> {
  if (!repo.sourceProfile) return undefined;
  const profile = profileStore.get(repo.sourceProfile);
  if (!profile) {
    logger?.warn(
      { sourceProfile: repo.sourceProfile, url: repo.url },
      'Reference repo source profile not found — cloning unauthenticated',
    );
    return undefined;
  }
  if (profile.prProvider === 'ado') return profile.adoPat ?? undefined;
  return (await githubAuth?.resolveCredential())?.token;
}
