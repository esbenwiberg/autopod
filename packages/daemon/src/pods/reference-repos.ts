import type { ReferenceRepo } from '@autopod/shared';
import type { Logger } from 'pino';
import { selectGitPat } from '../profiles/profile-pat.js';
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
 * Resolve the PAT to use when cloning a reference repo. When the repo was
 * picked from a profile, we authenticate as that profile (its `githubPat` /
 * `adoPat` per `prProvider`). Ad-hoc URLs and missing/empty profile PATs
 * fall through to undefined, which the clone path treats as "public/SSH".
 */
export function resolveRefRepoPat(
  repo: ReferenceRepo,
  profileStore: Pick<ProfileStore, 'get'>,
  logger?: Pick<Logger, 'warn'>,
): string | undefined {
  if (!repo.sourceProfile) return undefined;
  const profile = profileStore.get(repo.sourceProfile);
  if (!profile) {
    logger?.warn(
      { sourceProfile: repo.sourceProfile, url: repo.url },
      'Reference repo source profile not found — cloning unauthenticated',
    );
    return undefined;
  }
  return selectGitPat(profile);
}
