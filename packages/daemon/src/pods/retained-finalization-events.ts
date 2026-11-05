import type { Pod, PodStatus } from '@autopod/shared';
import type { EventBus } from './event-bus.js';
import type { PodRepository } from './pod-repository.js';
import { finalizationError } from './retained-finalization-repository.js';

/** Persist in the caller's terminal transaction; only fan-out waits for commit.
 * Deliberately no readiness/cleanup/dependent dispatch: this is observed delivery
 * or cancellation, not permission to start another worker.
 */
export function recordRetainedFinalizationEvents(
  pods: PodRepository,
  events: Pick<EventBus, 'emitAfterCommit'>,
  pod: Pod,
  previousStatus: PodStatus,
) {
  if (!pods.afterCommit || (pod.status !== 'complete' && pod.status !== 'killed'))
    finalizationError('Managed terminal event persistence is required.');
  const timestamp = pod.completedAt ?? new Date().toISOString();
  events.emitAfterCommit(
    { type: 'pod.status_changed', timestamp, podId: pod.id, previousStatus, newStatus: pod.status },
    pods.afterCommit,
  );
  events.emitAfterCommit(
    {
      type: 'pod.completed',
      timestamp,
      podId: pod.id,
      finalStatus: pod.status,
      summary: {
        id: pod.id,
        profileName: pod.profileName,
        task: pod.task,
        status: pod.status,
        model: pod.model,
        runtime: pod.runtime,
        duration: pod.startedAt ? Date.parse(timestamp) - Date.parse(pod.startedAt) : null,
        filesChanged: pod.filesChanged,
        createdAt: pod.createdAt,
      },
    },
    pods.afterCommit,
  );
}
