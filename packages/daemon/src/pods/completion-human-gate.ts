import type { Pod, ReportBlockerPayload } from '@autopod/shared';
import type { Logger } from 'pino';
import { atomicPodChange } from '../db/unit-of-work.js';
import type { EscalationRepository } from './escalation-repository.js';
import type { NudgeRepository } from './nudge-repository.js';
import type { PodRepository } from './pod-repository.js';

interface CompletionHumanGateDependencies {
  podRepo: Pick<PodRepository, 'getOrThrow' | 'completionJournal' | 'atomically'>;
  escalationRepo?: Pick<EscalationRepository, 'listBySession'>;
  nudgeRepo: Pick<NudgeRepository, 'hasPending'>;
  preservePodWorkspace(pod: Pod, reason: string): Promise<void>;
  ownsArtifactCompletion(
    pod: Pod,
    allowRemovedContainer?: boolean,
    allowQueuedGuidance?: boolean,
  ): boolean;
  transition(pod: Pod, to: 'failed', extraUpdates: { failureReason: string }): Pod;
  logger: Pick<Logger, 'error'>;
  emitActivityStatus(podId: string, message: string): void;
}

/** Hold completion for existing human work; an empty result keeps dispatch synchronous. */
export function createCompletionHumanGate(deps: CompletionHumanGateDependencies): {
  holdCompletionForHumanWork(pod: Pod): Promise<void> | undefined;
} {
  const {
    podRepo,
    nudgeRepo,
    preservePodWorkspace,
    ownsArtifactCompletion,
    transition,
    logger,
    emitActivityStatus,
  } = deps;

  // Worker settlement cannot discharge an unanswered human decision. Preserve
  // the workspace while retaining the waiter, even if its HTTP stream expired.
  async function holdForPendingQuestion(pod: Pod): Promise<void> {
    const podId = pod.id;
    const settlement = podRepo.completionJournal?.settle(pod);
    if (!settlement?.sourcePreservedAt && pod.containerId && pod.worktreePath) {
      try {
        await preservePodWorkspace(pod, 'waiting for human decision after agent settlement');
        podRepo.completionJournal?.mark(pod, 'awaiting_human', true);
      } catch (err) {
        logger.error(
          { err, podId },
          'Pending-decision workspace preservation failed; retaining worker resources',
        );
      }
    }
    emitActivityStatus(
      podId,
      'Agent settled; human decision remains unanswered. Review the pending question before continuing.',
    );
    return;
  }

  async function holdForQueuedGuidance(pod: Pod): Promise<void> {
    const podId = pod.id;
    // A recorded answer is not proof that the settled worker collected it.
    // Preserve source but retain the queue and resources for explicit Rework.
    podRepo.completionJournal?.settle(pod);
    let preserved = false;
    let preservationFailure = '';
    try {
      if (pod.containerId && pod.worktreePath) {
        await preservePodWorkspace(pod, 'uncollected human guidance after agent settlement');
        preserved = true;
      }
    } catch (err) {
      preservationFailure = ` Workspace preservation failed: ${err instanceof Error ? err.message : String(err)}.`;
      logger.error({ err, podId }, 'Uncollected-guidance preservation failed; retaining resources');
    }
    if (!ownsArtifactCompletion(pod, false, true)) return;
    const current = podRepo.getOrThrow(podId);
    const reason = `Worker settled with uncollected human guidance. Use Rework to read check_messages, acknowledge its receipt, and apply the saved guidance before validation or delivery.${preservationFailure} Original resources and guidance retained.`;
    atomicPodChange(podRepo, () => {
      podRepo.completionJournal?.mark(current, 'awaiting_human', preserved);
      transition(current, 'failed', { failureReason: reason });
    });
    emitActivityStatus(podId, reason);
    return;
  }

  async function holdForInfrastructure(pod: Pod, report: ReportBlockerPayload): Promise<void> {
    podRepo.completionJournal?.settle(pod);
    let preserved = false;
    let detail = '';
    try {
      if (pod.containerId && pod.worktreePath) {
        await preservePodWorkspace(pod, 'infrastructure blocker after agent settlement');
        preserved = true;
      }
    } catch (error) {
      detail = ` Workspace preservation failed: ${error instanceof Error ? error.message : String(error)}.`;
      logger.error(
        { error, podId: pod.id },
        'Infrastructure workspace preservation failed; retaining resources',
      );
    }
    if (!ownsArtifactCompletion(pod, false, true)) return;
    const current = podRepo.getOrThrow(pod.id);
    if (current.pendingEscalation || current.status !== 'running') return;
    const reason = `Infrastructure blocked${report.phase ? ` during ${report.phase}` : ''}: ${report.description}. Checks remain incomplete. Responsible system: ${report.owner ?? 'autopod'}. The execution owner must inspect the recorded report before supported recovery; no human answer or automatic coding retry is requested.${detail}`;
    atomicPodChange(podRepo, () => {
      podRepo.completionJournal?.mark(current, 'ready', preserved);
      transition(current, 'failed', { failureReason: reason });
    });
    emitActivityStatus(pod.id, reason);
  }

  function holdCompletionForHumanWork(pod: Pod): Promise<void> | undefined {
    if (pod.status === 'awaiting_input' || pod.pendingEscalation) {
      return holdForPendingQuestion(pod);
    }
    if (nudgeRepo.hasPending(pod.id)) return holdForQueuedGuidance(pod);
    const infrastructure = deps.escalationRepo
      ?.listBySession(pod.id)
      .find(
        (entry) =>
          entry.type === 'report_blocker' &&
          'kind' in entry.payload &&
          entry.payload.kind === 'infrastructure' &&
          entry.payload.lifecycleGeneration === pod.lifecycleGeneration,
      );
    if (
      infrastructure &&
      'description' in infrastructure.payload &&
      'needs' in infrastructure.payload
    )
      return holdForInfrastructure(pod, infrastructure.payload);
    return undefined;
  }

  return { holdCompletionForHumanWork };
}
