import type { Pod } from '@autopod/shared';

/** Ordinary artifacts require entered collection; explicit findings also recover settled ready cycles. */
export function hasInterruptedArtifactCollection(pod: Pod): boolean {
  return (
    (pod.options?.output === 'artifact' || pod.completionPolicy === 'accept-findings') &&
    ['running', 'paused', 'failed'].includes(pod.status) &&
    pod.finalization?.generation === pod.lifecycleGeneration &&
    (pod.finalization?.phase === 'preserving' ||
      (pod.completionPolicy === 'accept-findings' && pod.finalization?.phase === 'ready')) &&
    Boolean(pod.finalization.agentSettledAt) &&
    !pod.finalization.pendingDecisionId &&
    !pod.pendingEscalation
  );
}

export const ARTIFACT_RESTART_REASON =
  'Artifact finalization was interrupted by daemon restart. The recorded source and snapshot are retained. Resume artifact finalization; do not restart the settled worker.';
