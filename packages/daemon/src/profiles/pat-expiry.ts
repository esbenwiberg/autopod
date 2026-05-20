import { AutopodError, type Profile } from '@autopod/shared';

export const PAT_EXPIRY_WARNING_DAYS = 7;

export interface ExpiredPat {
  field: 'githubPatExpiresAt' | 'adoPatExpiresAt' | 'registryPatExpiresAt';
  label: string;
  expiresAt: string;
}

function todayDateString(now = new Date()): string {
  const year = now.getFullYear();
  const month = `${now.getMonth() + 1}`.padStart(2, '0');
  const day = `${now.getDate()}`.padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function isExpired(expiresAt: string | null | undefined, today: string): expiresAt is string {
  return typeof expiresAt === 'string' && expiresAt.length > 0 && expiresAt < today;
}

export function findExpiredPat(profile: Profile, now = new Date()): ExpiredPat | null {
  const today = todayDateString(now);

  if (
    profile.prProvider === 'github' &&
    profile.githubPat &&
    isExpired(profile.githubPatExpiresAt, today)
  ) {
    return {
      field: 'githubPatExpiresAt',
      label: 'GitHub PAT',
      expiresAt: profile.githubPatExpiresAt,
    };
  }

  if (profile.prProvider === 'ado' && profile.adoPat && isExpired(profile.adoPatExpiresAt, today)) {
    return {
      field: 'adoPatExpiresAt',
      label: 'ADO PAT',
      expiresAt: profile.adoPatExpiresAt,
    };
  }

  if (profile.privateRegistries.length === 0) return null;

  if (profile.registryPat && isExpired(profile.registryPatExpiresAt, today)) {
    return {
      field: 'registryPatExpiresAt',
      label: 'Registry PAT',
      expiresAt: profile.registryPatExpiresAt,
    };
  }

  if (!profile.registryPat && profile.adoPat && isExpired(profile.adoPatExpiresAt, today)) {
    return {
      field: 'adoPatExpiresAt',
      label: 'ADO PAT used for registry auth',
      expiresAt: profile.adoPatExpiresAt,
    };
  }

  return null;
}

export function assertNoExpiredPat(profile: Profile, now = new Date()): void {
  const expired = findExpiredPat(profile, now);
  if (!expired) return;
  throw new AutopodError(
    `Profile "${profile.name}" has an expired ${expired.label} (${expired.expiresAt}). Update the PAT and expiry date before creating a pod.`,
    'PAT_EXPIRED',
    400,
  );
}
