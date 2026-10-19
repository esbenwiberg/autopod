import {
  type ArtifactResumeObservation,
  observeArtifactResume,
} from './artifact-resume-observation.js';
import type {
  WorkspaceObservationCaptured,
  WorkspaceObservationLiveDependencies,
} from './workspace-contracts.js';

export function createWorkspaceArtifactObservation(
  deps: WorkspaceObservationLiveDependencies,
  captured: WorkspaceObservationCaptured,
) {
  const {
    assertExecutionTerminationVerified,
    assertGuidanceCollected,
    podRepo,
    artifactResumeRuns,
    artifactCompletionRuns,
  } = captured;

  function getArtifactResumeObservation(podId: string): ArtifactResumeObservation {
    const unavailable: ArtifactResumeObservation = {
      protocol: 'artifact-resume-observation-v1',
      state: 'unavailable',
      operations: [],
    };
    if (!deps.eventRepo) return unavailable;
    try {
      assertExecutionTerminationVerified(podId);
      assertGuidanceCollected(podId);
      if (podRepo.taskExecutions?.hasActiveRun(podId)) return unavailable;
      const pod = podRepo.getOrThrow(podId);
      const key = `${pod.id}:${pod.lifecycleGeneration}:${pod.finalization?.cycle ?? 0}`;
      return observeArtifactResume(
        pod,
        deps.eventRepo.getForSession(podId),
        artifactResumeRuns.has(podId) || artifactCompletionRuns.has(key),
      );
    } catch {
      // Reading status must never resume a process or claim an unavailable exit.
      return unavailable;
    }
  }
  return { getArtifactResumeObservation };
}
