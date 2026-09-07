import { AutopodError } from '@autopod/shared';

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
