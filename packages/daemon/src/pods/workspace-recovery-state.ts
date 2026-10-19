import { createInteractiveCompletionCoordinator } from './interactive-completion-coordinator.js';
import type { WorkspaceCompletionResult } from './workspace-contracts.js';

export function createWorkspaceRecoveryState(): {
  infrastructureResumeRuns: Map<string, Promise<void>>;
  artifactResumeRuns: Map<string, Promise<void>>;
  artifactCompletionRuns: Map<string, Promise<void>>;
  coordinateInteractiveCompletion: ReturnType<
    typeof createInteractiveCompletionCoordinator<WorkspaceCompletionResult>
  >;
} {
  const infrastructureResumeRuns = new Map<string, Promise<void>>();
  const artifactResumeRuns = new Map<string, Promise<void>>();
  const artifactCompletionRuns = new Map<string, Promise<void>>();
  const coordinateInteractiveCompletion =
    createInteractiveCompletionCoordinator<WorkspaceCompletionResult>();

  return {
    infrastructureResumeRuns,
    artifactResumeRuns,
    artifactCompletionRuns,
    coordinateInteractiveCompletion,
  };
}

export function createWorkspaceLeaseState() {
  const forceWithLeaseAllowances = new Set<string>();

  return { forceWithLeaseAllowances };
}
