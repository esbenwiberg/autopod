import type { Pod, PodStatus } from '@autopod/shared';
import type { CompletionEventsCaptured } from './completion-ports.js';
import type { PodUpdates } from './pod-repository.js';
import { isTerminalState, validateTransition } from './state-machine.js';

export function createCompletionEvents(captured: CompletionEventsCaptured) {
  const {
    eventBus,
    bumpActivityTimestamp,
    recordNotReportedMemoryUsage,
    podRepo,
    refreshReadiness,
  } = captured;

  function emitActivityStatus(podId: string, message: string): void {
    eventBus.emit({
      type: 'pod.agent_activity',
      timestamp: new Date().toISOString(),
      podId,
      event: { type: 'status', timestamp: new Date().toISOString(), message },
    });
    // Status emissions are also liveness signals — bootstrap/recovery progress
    // would otherwise be invisible to the watchdog and trigger a false auto-fail
    // before the agent process has even spawned.
    bumpActivityTimestamp(podId);
  }

  function emitActivityError(podId: string, message: string, fatal = true): void {
    const timestamp = new Date().toISOString();
    eventBus.emit({
      type: 'pod.agent_activity',
      timestamp,
      podId,
      event: { type: 'error', timestamp, message, fatal },
    });
    bumpActivityTimestamp(podId);
  }

  function transition(pod: Pod, to: PodStatus, extraUpdates?: Partial<PodUpdates>): Pod {
    validateTransition(pod.id, pod.status, to);
    const previousStatus = pod.status;
    const updates: PodUpdates = { status: to, ...extraUpdates };
    // Successful completion implicitly resolves any prior worktree-compromised
    // warning — the pod finished, branch was pushed, no recovery needed. Don't
    // clear on failed/killed/rejected; those are real bad-state terminals where
    // the banner is still actionable.
    if (to === 'complete' && pod.worktreeCompromised && updates.worktreeCompromised === undefined) {
      updates.worktreeCompromised = false;
    }
    if (isTerminalState(to)) {
      recordNotReportedMemoryUsage(pod.id);
    }
    podRepo.update(pod.id, updates);
    if (to === 'complete') podRepo.completionJournal?.mark(pod, 'finished');
    else if (to === 'research_ready') podRepo.completionJournal?.mark(pod, 'ready');
    else if (to === 'validating') podRepo.completionJournal?.mark(pod, 'finalizing');
    const publish = () => {
      eventBus.emit({
        type: 'pod.status_changed',
        timestamp: new Date().toISOString(),
        podId: pod.id,
        previousStatus,
        newStatus: to,
      });
    };
    if (podRepo.afterCommit) podRepo.afterCommit(publish);
    else publish();
    if (
      to === 'research_ready' ||
      to === 'validated' ||
      to === 'review_required' ||
      to === 'failed'
    ) {
      refreshReadiness(pod.id);
    }
    return podRepo.getOrThrow(pod.id);
  }

  function emitPodCompletedEvent(pod: Pod, filesChanged = pod.filesChanged): void {
    eventBus.emit({
      type: 'pod.completed',
      timestamp: new Date().toISOString(),
      podId: pod.id,
      finalStatus: 'complete',
      summary: {
        id: pod.id,
        profileName: pod.profileName,
        task: pod.task,
        status: 'complete',
        model: pod.model,
        runtime: pod.runtime,
        duration: pod.startedAt ? Date.now() - new Date(pod.startedAt).getTime() : null,
        filesChanged,
        createdAt: pod.createdAt,
      },
    });
  }
  return { emitActivityStatus, emitActivityError, transition, emitPodCompletedEvent };
}
