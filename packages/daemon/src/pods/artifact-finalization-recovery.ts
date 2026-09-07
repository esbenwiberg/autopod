import type { Pod } from '@autopod/shared';

/** This phase records an entered collection, not merely an older worker completion. */
export function hasInterruptedArtifactCollection(pod: Pod): boolean {
  return (
    pod.options?.output === 'artifact' &&
    ['running', 'paused', 'failed'].includes(pod.status) &&
    pod.finalization?.generation === pod.lifecycleGeneration &&
    pod.finalization?.phase === 'preserving' &&
    Boolean(pod.finalization.agentSettledAt) &&
    !pod.finalization.pendingDecisionId &&
    !pod.pendingEscalation
  );
}

export const ARTIFACT_RESTART_REASON =
  'Artifact finalization was interrupted by daemon restart. The recorded source and snapshot are retained. Resume artifact finalization; do not restart the settled worker.';
