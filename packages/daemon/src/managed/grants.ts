import {
  type ManagedPodRequest,
  type ProfileSnapshot,
  type Scope,
  parseManagedRecord,
} from '@autopod/shared';
import { canonical, digest } from './canonical.js';

export const REQUIRED_ENFORCEMENT = [
  'repositories',
  'network',
  'identities',
  'effects',
  'budget',
  'autonomous-expiry',
] as const;
export interface ManagedAdmission {
  profiles: ReadonlyMap<string, ProfileSnapshot>;
  enrollmentCeiling: Scope;
  identityCeiling: Scope;
  backendCeiling: Scope;
  enforcement: readonly string[];
  targets: readonly ('local' | 'sandbox')[];
  /** Optional single-job boundary. When present, no other request can be admitted. */
  expectedRequest?: ManagedPodRequest;
  /** Additional reviewed profile contract over task, inputs, outputs and verifier. */
  requestPolicy?: (request: ManagedPodRequest) => void;
}
function checkDigest(value: object, field: string): void {
  const record = value as Record<string, unknown>;
  if (
    record[field] !==
    digest(Object.fromEntries(Object.entries(record).filter(([key]) => key !== field)))
  ) {
    throw new Error('managed-digest-mismatch');
  }
}
export function validateManagedRequest(raw: unknown): ManagedPodRequest {
  const request = parseManagedRecord('ManagedPodRequestSchema', raw);
  checkDigest(request, 'executionSpecDigest');
  checkDigest(request.profileSnapshot, 'snapshotDigest');
  checkDigest(request.effectiveGrant, 'digest');
  if (
    request.effectiveGrant.dispatcherAttemptId !== request.dispatcherAttemptId ||
    request.effectiveGrant.profileSnapshotDigest !== request.profileSnapshot.snapshotDigest ||
    canonical(request.route) !== canonical(request.effectiveGrant.route) ||
    canonical(request.route) !== canonical(request.profileSnapshot.route)
  )
    throw new Error('managed-binding-mismatch');
  return request;
}
export function requireSubset(scope: Scope, ceiling: Scope): void {
  if (scope.allowedEffects.some((effect) => !ceiling.allowedEffects.includes(effect)))
    throw new Error('grant-effects-outside-ceiling');
  if (scope.network.destinations.some((host) => !ceiling.network.destinations.includes(host)))
    throw new Error('grant-network-outside-ceiling');
  if (
    scope.identityBindings.some(
      (binding) =>
        !ceiling.identityBindings.some((other) => canonical(other) === canonical(binding)),
    )
  ) {
    throw new Error('grant-identity-outside-ceiling');
  }
  for (const repository of scope.repositories) {
    const matches = ceiling.repositories.filter(
      (other) => other.enrollmentId === repository.enrollmentId,
    );
    const other = matches[0];
    if (
      matches.length !== 1 ||
      !other ||
      repository.remote !== other.remote ||
      repository.baseRevision !== other.baseRevision ||
      repository.branchNamespace !== other.branchNamespace ||
      (repository.access === 'write' && other.access !== 'write')
    ) {
      throw new Error('grant-repository-outside-ceiling');
    }
  }
}
export function admitManagedRequest(
  request: ManagedPodRequest,
  policy: ManagedAdmission,
  now: number,
): void {
  if (policy.expectedRequest && canonical(request) !== canonical(policy.expectedRequest))
    throw new Error('managed-request-not-reviewed');
  policy.requestPolicy?.(request);
  const profile = policy.profiles.get(request.profileSnapshot.snapshotDigest);
  if (!profile || canonical(profile) !== canonical(request.profileSnapshot))
    throw new Error('managed-profile-not-reviewed');
  if (
    !policy.targets.includes(request.route.executionTarget) ||
    REQUIRED_ENFORCEMENT.some((cap) => !policy.enforcement.includes(cap))
  ) {
    throw new Error('grant-restriction-unenforceable');
  }
  const grant = request.effectiveGrant;
  for (const ceiling of [
    profile.scope,
    policy.enrollmentCeiling,
    policy.identityCeiling,
    policy.backendCeiling,
  ])
    requireSubset(grant.scope, ceiling);
  if ('mode' in grant.budget !== 'mode' in profile.budget)
    throw new Error('grant-budget-mode-mismatch');
  for (const [key, value] of Object.entries(grant.budget)) {
    if (key === 'mode') continue;
    const ceiling = (profile.budget as unknown as Record<string, number>)[key];
    if (typeof value !== 'number' || ceiling === undefined || value > ceiling || value <= 0)
      throw new Error('grant-budget-outside-ceiling');
  }
  if (grant.budget.expiresAt <= now) throw new Error('grant-expired');
  const source = request.outputs.source;
  const required: Record<typeof source.mode, string[]> = {
    none: [],
    commit: ['git.commit'],
    branch: ['git.commit', 'git.push.worker-branch'],
    'draft-pr': ['git.commit', 'git.push.worker-branch', 'pull-request.create-draft'],
  };
  if (
    required[source.mode].some(
      (effect) => !grant.scope.allowedEffects.some((value) => value === effect),
    )
  )
    throw new Error('source-effects-not-granted');
  if (source.mode !== 'none') {
    const repo = grant.scope.repositories.find(
      (repository) => repository.enrollmentId === source.repository,
    );
    if (
      !repo ||
      repo.access !== 'write' ||
      source.remote !== repo.remote ||
      !source.head.startsWith(repo.branchNamespace) ||
      source.head === source.base
    )
      throw new Error('source-binding-not-granted');
  }
}
