import { AutopodError } from '@autopod/shared';
import type { CompletionGuardsCaptured } from './completion-ports.js';
import { assertTaskExecutionTerminationVerified } from './task-execution-ledger.js';

export function createCompletionGuards(captured: CompletionGuardsCaptured) {
  const { podRepo, nudgeRepo } = captured;

  function assertExecutionTerminationVerified(podId: string): void {
    podRepo.sourceAdoptions?.assertAvailable(podId);
    podRepo.deletionOwnership?.assertTaskAvailable(podId);
    assertTaskExecutionTerminationVerified(podRepo.taskExecutions, podId);
  }

  function assertGuidanceCollected(podId: string): void {
    if (nudgeRepo.hasPending(podId))
      throw new AutopodError(
        'This pod has uncollected human guidance. Use Rework to let a worker read check_messages, acknowledge its receipt, and apply the saved guidance before validation or delivery.',
        'UNCOLLECTED_HUMAN_GUIDANCE',
        409,
      );
  }

  function ownsLifecycle(podId: string, generation: number, containerId: string | null): boolean {
    const current = podRepo.getOrThrow(podId);
    return (
      current.lifecycleGeneration === generation &&
      (containerId === null || current.containerId === containerId)
    );
  }
  return { assertExecutionTerminationVerified, assertGuidanceCollected, ownsLifecycle };
}
