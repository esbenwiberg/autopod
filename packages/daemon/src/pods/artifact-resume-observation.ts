import type { Pod } from '@autopod/shared';
import type { StoredEvent } from './event-repository.js';

export interface ArtifactResumeObservation {
  protocol: 'artifact-resume-observation-v1';
  state: 'unavailable' | 'settled-failed';
  binding?: {
    podId: string;
    generation: number;
    cycle: number;
    containerId: string;
    agentSettledAt: string;
    profileName: string;
    runtime: string;
    model: string;
    providerAccountId: string | null;
  };
  operations: Array<{
    identity: string;
    startedEventId: number;
    failedEventId: number;
    state: 'failed';
    agentRerun: false;
  }>;
}

/** Read-only legacy observation. It does not recover an HTTP response or a request key. */
export function observeArtifactResume(
  pod: Pod,
  events: StoredEvent[],
  collectionInFlight: boolean,
): ArtifactResumeObservation {
  const unavailable: ArtifactResumeObservation = {
    protocol: 'artifact-resume-observation-v1',
    state: 'unavailable',
    operations: [],
  };
  const finalization = pod.finalization;
  const failure =
    'Artifact preservation failed. Original container retained; retry collection before completing.';
  if (
    collectionInFlight ||
    pod.status !== 'failed' ||
    pod.options.output !== 'artifact' ||
    !pod.containerId ||
    pod.pendingEscalation ||
    finalization?.pendingDecisionId ||
    finalization?.generation !== pod.lifecycleGeneration ||
    finalization.phase !== 'preserving' ||
    finalization.sourcePreservedAt ||
    !finalization.agentSettledAt ||
    pod.failureReason !== failure ||
    !Number.isSafeInteger(finalization.cycle) ||
    finalization.cycle < 1
  )
    return unavailable;
  const settled = Date.parse(finalization.agentSettledAt);
  const updated = Date.parse(pod.updatedAt);
  if (!Number.isFinite(settled) || !Number.isFinite(updated)) return unavailable;
  const operations: ArtifactResumeObservation['operations'] = [];
  let started: number | null = null;
  let collected = false;
  let previousId = 0;
  for (const entry of events) {
    if (!Number.isSafeInteger(entry.id) || entry.id <= previousId || entry.podId !== pod.id)
      return unavailable;
    previousId = entry.id;
    if (entry.payload.type !== 'pod.agent_activity') continue;
    const event = entry.payload.event;
    const timestamp = Date.parse(event.timestamp);
    if (!Number.isFinite(timestamp)) return unavailable;
    if (timestamp <= settled) continue;
    if (
      event.type === 'status' &&
      event.message === 'Resume: retrying artifact collection from the settled worker…'
    ) {
      if (started !== null) return unavailable;
      started = entry.id;
      collected = false;
    } else if (started !== null) {
      if (timestamp > updated) return unavailable;
      if (event.type === 'status' && event.message === 'Collecting artifacts…') {
        collected = true;
      } else if (event.type === 'error' && !event.fatal && event.message === failure && collected) {
        operations.push({
          identity: `${pod.id}:${pod.lifecycleGeneration}:${finalization.cycle}:${started}:${entry.id}`,
          startedEventId: started,
          failedEventId: entry.id,
          state: 'failed',
          agentRerun: false,
        });
        started = null;
      } else {
        // Any unrecognized intervening activity makes causal attribution unavailable.
        return unavailable;
      }
    }
  }
  if (started !== null || !operations.length || operations.length > 16) return unavailable;
  return {
    protocol: 'artifact-resume-observation-v1',
    state: 'settled-failed',
    binding: {
      podId: pod.id,
      generation: pod.lifecycleGeneration,
      cycle: finalization.cycle,
      containerId: pod.containerId,
      agentSettledAt: finalization.agentSettledAt,
      profileName: pod.profileName,
      runtime: pod.runtime,
      model: pod.model,
      providerAccountId: pod.providerAccountIdSnapshot ?? null,
    },
    operations,
  };
}
