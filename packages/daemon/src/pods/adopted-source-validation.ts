import type { Pod } from '@autopod/shared';
import type { PodExecutionSettings } from '../interfaces/pod-execution-settings.js';
import type { PodRepository } from './pod-repository.js';
import { sourceAdoptionError, sourcePodFingerprint } from './source-adoption-repository.js';
import { ValidationSupersededError } from './validation-ownership.js';

/** Private capability supplied by the adoption coordinator, never deserialized from HTTP. */
export interface AdoptedSourceValidationRequest {
  operationId: string;
  verifySource(): Promise<void>;
}
export function openAdoptedSourceValidation(
  podRepo: PodRepository,
  podId: string,
  request: AdoptedSourceValidationRequest,
  executionForPod: (pod: Pod) => PodExecutionSettings,
  assertGuidanceCollected: (podId: string) => void,
) {
  const journal = podRepo.sourceAdoptions;
  const admitted = journal?.get(request.operationId);
  if (
    !journal ||
    !admitted ||
    admitted.podId !== podId ||
    admitted.stage !== 'checking' ||
    admitted.error ||
    !admitted.preservation ||
    !admitted.adoptedGeneration
  )
    sourceAdoptionError('No source-bound checks admission exists', 'SOURCE_CHECKS_NOT_ADMITTED');
  const initial = podRepo.getOrThrow(podId);
  const setupCommand =
    admitted.binding.dependencySetupCommand ?? executionForPod(initial).validationSetupCommand;
  if (!setupCommand?.trim())
    sourceAdoptionError(
      'Fresh adopted-source validation requires explicitly configured/admitted dependency preparation.',
      'SOURCE_DEPENDENCY_SETUP_REQUIRED',
    );
  const assertCurrent = () => {
    const row = journal.get(request.operationId);
    const pod = podRepo.getOrThrow(podId);
    if (
      !row ||
      row.stage !== 'checking' ||
      row.error ||
      row.podId !== podId ||
      row.adoptedGeneration !== pod.lifecycleGeneration ||
      sourcePodFingerprint(pod) !== row.binding.fingerprint ||
      pod.containerId !== row.binding.containerId ||
      pod.worktreePath !== row.binding.worktreePath ||
      pod.branch !== row.binding.branch ||
      pod.pendingEscalation ||
      !['failed', 'review_required', 'validated', 'validating'].includes(pod.status)
    )
      throw new ValidationSupersededError();
    const profile = executionForPod(pod);
    if (
      profile.repoUrl !== row.binding.repository ||
      (pod.baseBranch ?? profile.defaultBranch ?? 'main') !== row.binding.baseBranch
    )
      throw new ValidationSupersededError();
    journal.assertAvailable(podId, request.operationId);
    assertGuidanceCollected(podId);
    return pod;
  };
  async function owned<T>(operation: () => Promise<T>): Promise<T> {
    assertCurrent();
    try {
      const result = await operation();
      assertCurrent();
      return result;
    } catch (error) {
      // A rejected old await must not mark a replacement lifecycle as failed.
      assertCurrent();
      throw error;
    }
  }
  const verify = () => owned(() => request.verifySource());
  assertCurrent();
  if (initial.lastValidationResult !== null)
    sourceAdoptionError(
      'Old validation was not invalidated at source mutation admission',
      'SOURCE_VALIDATION_NOT_INVALIDATED',
    );
  return {
    assertCurrent,
    owned,
    verify,
    setupCommand,
    claimInvocation: () => journal.claimChecksInvocation(request.operationId, assertCurrent),
  };
}
