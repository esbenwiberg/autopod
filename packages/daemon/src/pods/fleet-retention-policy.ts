import type { Pod } from '@autopod/shared';
import type { PodRepository } from './pod-repository.js';

export function isOrdinaryFleetTask(repo: PodRepository, pod: Pod): boolean {
  return pod.options.agentMode !== 'interactive' && !repo.validationExecutions?.hasGoal(pod.id);
}

export function retainFleetDisposition(repo: PodRepository, pod: Pod): boolean {
  // Older releases also used 'manual' for automatic recovery parking. That legacy
  // intent is ambiguous: retain it rather than invent permission to execute.
  return (
    isOrdinaryFleetTask(repo, pod) &&
    Boolean(pod.fleetArchivedAt || (pod.status === 'paused' && pod.pauseReason === 'manual'))
  );
}

export class FleetRetentionFence extends Error {
  constructor(podId: string) {
    super(`Fleet disposition changed for ${podId}; retain original state and resources`);
    this.name = 'FleetRetentionFence';
  }
}

/** Check again after awaits and immediately before admitting another recovery effect. */
export function assertFleetRecoveryAllowed(repo: PodRepository, podId: string): void {
  if (retainFleetDisposition(repo, repo.getOrThrow(podId))) throw new FleetRetentionFence(podId);
}
