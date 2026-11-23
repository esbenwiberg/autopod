import type { ManagedPodRequest } from '@autopod/shared';

export const PRIVATE_PARENT_VERIFIER = 'parent-private-commit-v1';
export const PRIVATE_SUBMISSION_FILE = 'change-submission.json';
export const PRIVATE_SUBMISSION_MAX_BYTES = 16 * 1024;
export function isPrivateSubmission(request: ManagedPodRequest) {
  return (
    isPrivateParentCommit(request) &&
    request.route.executionTarget === 'sandbox' &&
    request.outputs.artifacts.requiredPaths[0] === PRIVATE_SUBMISSION_FILE
  );
}

export const PRIVATE_COMMIT_EFFECTS = [
  'repository.read',
  'repository.write',
  'git.commit',
  'artifact.write',
] as const;

export function isPrivateParentCommit(request: ManagedPodRequest) {
  return request.validation.verifierPolicy === PRIVATE_PARENT_VERIFIER;
}

export function assertPrivateParentCommit(
  request: ManagedPodRequest,
  repository: string,
  base: string,
  target: 'local' | 'sandbox' = 'local',
) {
  const { scope, budget } = request.effectiveGrant;
  const [repo] = scope.repositories;
  const { source, artifacts } = request.outputs;
  if (
    !isPrivateParentCommit(request) ||
    request.task.kind !== 'implementation' ||
    request.route.runtime !== 'codex' ||
    request.route.executionTarget !== target ||
    source.mode !== 'commit' ||
    source.remote !== 'private' ||
    source.repository !== repository ||
    request.inputArtifacts.length ||
    request.task.contextFiles?.length ||
    request.validation.autopod ||
    scope.repositories.length !== 1 ||
    !repo ||
    repo.enrollmentId !== repository ||
    repo.access !== 'write' ||
    repo.remote !== 'private' ||
    repo.baseRevision !== base ||
    scope.network.destinations.length ||
    scope.identityBindings.length ||
    scope.allowedEffects.length !== PRIVATE_COMMIT_EFFECTS.length ||
    PRIVATE_COMMIT_EFFECTS.some((effect) => !scope.allowedEffects.includes(effect)) ||
    artifacts.mode !== 'required' ||
    artifacts.include.length !== 1 ||
    artifacts.requiredPaths.length !== 1 ||
    artifacts.include[0] !== artifacts.requiredPaths[0] ||
    (isPrivateSubmission(request)
      ? artifacts.limits.maxFiles !== 1 ||
        artifacts.limits.maxFileBytes > PRIVATE_SUBMISSION_MAX_BYTES ||
        artifacts.limits.maxTotalBytes > PRIVATE_SUBMISSION_MAX_BYTES
      : artifacts.requiredPaths[0] !== 'report.md') ||
    !('maxProviderRequests' in budget) ||
    budget.maxProviderRequests > 6 ||
    budget.maxDurationSeconds > 900
  )
    throw new Error('parent-coding-recipe-not-confined');
}
