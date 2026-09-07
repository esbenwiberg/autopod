import { AutopodError } from '@autopod/shared';
import type { MergePrTarget } from '../interfaces/pr-manager.js';
import { parseGitHubRepoUrl } from './github-url-identity.js';

export function sourceCommit(value: unknown): string | undefined {
  return typeof value === 'string' && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value)
    ? value
    : undefined;
}

export function mergeReconciliation(message: string): never {
  throw new AutopodError(
    `${message} Retain source resources and reconcile the PR before retrying delivery.`,
    'DELIVERY_RECONCILIATION_REQUIRED',
    409,
  );
}

export function expectedMergeSource(value: string | undefined): string | undefined {
  if (value !== undefined && !sourceCommit(value))
    mergeReconciliation('The expected merge source commit is invalid.');
  return value;
}

export function assertMergeSource(expected: string | undefined, observed: unknown): void {
  if (expected !== undefined && sourceCommit(observed) !== expected)
    mergeReconciliation('The PR source does not match the confirmed published commit.');
}

function repositoryKey(value: unknown): string {
  if (typeof value !== 'string' || value.length > 4096)
    return mergeReconciliation('The merge repository identity is unavailable.');
  try {
    if (value.startsWith('git@github.com:') || new URL(value).hostname === 'github.com') {
      const parsed = parseGitHubRepoUrl(value);
      return JSON.stringify(['github', parsed.owner.toLowerCase(), parsed.repo.toLowerCase()]);
    }
    const url = new URL(value);
    if (
      url.protocol !== 'https:' ||
      url.port ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      return mergeReconciliation('The merge repository address is unsupported.');
    const parts = url.pathname.replace(/\/$/, '').split('/').slice(1).map(decodeURIComponent);
    if (url.hostname === 'dev.azure.com' && parts.length === 4 && parts[2] === '_git')
      return JSON.stringify(['ado', parts[0]?.toLowerCase(), parts[1], parts[3]]);
    if (url.hostname.endsWith('.visualstudio.com') && parts.length === 3 && parts[1] === '_git')
      return JSON.stringify([
        'ado',
        url.hostname.slice(0, -'.visualstudio.com'.length),
        parts[0],
        parts[2],
      ]);
  } catch {
    return mergeReconciliation('The merge repository address is unsupported.');
  }
  return mergeReconciliation('The merge repository address is unsupported.');
}

export function assertMergeRepository(
  expected: MergePrTarget | undefined,
  observed: unknown,
): void {
  if (expected && repositoryKey(expected.repository) !== repositoryKey(observed))
    mergeReconciliation('The PR repository does not match the confirmed published source.');
}

export function assertMergeTarget(
  expected: MergePrTarget | undefined,
  observed: {
    repository?: unknown;
    branch?: unknown;
    baseBranch?: unknown;
  },
): void {
  if (!expected) return;
  assertMergeRepository(expected, observed.repository);
  for (const field of ['branch', 'baseBranch'] as const) {
    const value = expected[field];
    if (
      typeof value !== 'string' ||
      !value.length ||
      value.length > 1024 ||
      value.trim() !== value ||
      value.includes('\0') ||
      value.includes('\r') ||
      value.includes('\n') ||
      observed[field] !== value
    )
      mergeReconciliation(
        'The PR source or base branch does not match the admitted delivery target.',
      );
  }
}
