import type { Pod, PodOptions } from '@autopod/shared';
import type { Logger } from 'pino';
import type { PodExecutionSettings } from '../interfaces/pod-execution-settings.js';
import type { CompletionSourcePreparation } from './completion-source.js';
import type { PodRepository, PodUpdates } from './pod-repository.js';

interface CompletionDecisionDependencies {
  podRepo: Pick<PodRepository, 'getOrThrow'>;
  executionForPod(pod: Pod): PodExecutionSettings;
  isPodValidationDisabled(pod: Pod): boolean;
  getPodValidationSuite(pod: Pod): NonNullable<PodOptions['validationSuite']>;
  reworkInProgressPrefix: string;
  cleanupContainer(pod: Pod, label: 'no-changes-complete'): Promise<void>;
  transition(
    pod: Pod,
    to: 'failed' | 'complete' | 'validating' | 'validated',
    extraUpdates?: Partial<Pick<PodUpdates, 'completedAt' | 'lastCorrectionMessage'>>,
  ): Pod;
  emitPodCompletedEvent(pod: Pod, filesChanged: number): void;
  maybeTriggerDependents(pod: Pod): void;
  emitActivityStatus(podId: string, message: string): void;
  logger: Pick<Logger, 'info'>;
}

/** Apply the existing source completion rules and their ordered effects. */
export function createCompletionDecision(deps: CompletionDecisionDependencies): {
  applyCompletionDecision(
    pod: Pod,
    preparedSource: CompletionSourcePreparation,
    triggerValidation: (podId: string) => Promise<void>,
  ): Promise<void>;
} {
  const {
    podRepo,
    executionForPod,
    isPodValidationDisabled,
    getPodValidationSuite,
    reworkInProgressPrefix: REWORK_IN_PROGRESS_PREFIX,
    cleanupContainer,
    transition,
    emitPodCompletedEvent,
    maybeTriggerDependents,
    emitActivityStatus,
    logger,
  } = deps;

  async function applyCompletionDecision(
    pod: Pod,
    preparedSource: CompletionSourcePreparation,
    triggerValidation: (podId: string) => Promise<void>,
  ): Promise<void> {
    const podId = pod.id;
    const { sandboxCheckpoint, sandboxCanonicalOutcome, sandboxHostProof } = preparedSource;

    // Finish or skip validation if requested or if agent made no changes.
    // Forked pods (linked or branched off a non-default branch) always validate —
    // the parent branch's changes need validation even when the forked agent adds nothing.
    const refreshed = podRepo.getOrThrow(podId);
    const profile2 = executionForPod(refreshed);
    const noChanges =
      pod.executionTarget === 'sandbox'
        ? sandboxCanonicalOutcome === 'unchanged'
        : Boolean(pod.worktreePath) && refreshed.filesChanged === 0;
    const isForkSession =
      Boolean(refreshed.linkedPodId) ||
      (refreshed.baseBranch != null && refreshed.baseBranch !== profile2.defaultBranch);
    const isScheduledSession = refreshed.scheduledJobId !== null;
    const noChangesAfterRework =
      noChanges && refreshed.lastCorrectionMessage?.startsWith(REWORK_IN_PROGRESS_PREFIX);
    const validationDisabled = isPodValidationDisabled(refreshed);
    // A sandbox checkpoint is source-delivery authority. A non-empty
    // canonical snapshot must always receive blocking validation; the
    // skip-validation preference cannot turn verified deliverable work into
    // an unvalidated terminal result.
    const forceSandboxValidation =
      refreshed.executionTarget === 'sandbox' && sandboxCanonicalOutcome === 'changed';
    if (pod.executionTarget === 'sandbox' && sandboxCheckpoint && sandboxCanonicalOutcome) {
      logger.info(
        {
          podId,
          attempt: refreshed.validationAttempts,
          checkpointSequence: sandboxCheckpoint.sequence,
          baseCommit: refreshed.startCommitSha?.slice(0, 12) ?? null,
          branch: refreshed.branch,
          checkpointCommit: sandboxCheckpoint.snapshotCommit.slice(0, 12),
          checkpointTree: sandboxCheckpoint.snapshotTree.slice(0, 12),
          hostHead: sandboxHostProof?.head.slice(0, 12) ?? null,
          hostTree: sandboxHostProof?.tree.slice(0, 12) ?? null,
          outcome: sandboxCanonicalOutcome,
          stats: {
            filesChanged: refreshed.filesChanged,
            linesAdded: refreshed.linesAdded,
            linesRemoved: refreshed.linesRemoved,
          },
          predicateFlags: { noChanges, isForkSession, isScheduledSession, validationDisabled },
          lifecycleDecision:
            noChanges && !isForkSession && !validationDisabled ? 'complete' : 'validate',
          cleanupSelected: noChanges && !isForkSession && !validationDisabled,
          validationSelected: forceSandboxValidation || !noChanges || isForkSession,
          prEligible: forceSandboxValidation || !noChanges || isForkSession,
        },
        'Sandbox finalization proof and decision',
      );
    }
    if (noChangesAfterRework && !validationDisabled && !isForkSession && !isScheduledSession) {
      const message = 'Rework produced no file changes.';
      logger.info({ podId }, 'Failing pod because rework produced no file changes');
      emitActivityStatus(podId, `${message} Marking pod failed.`);
      transition(refreshed, 'failed', {
        completedAt: new Date().toISOString(),
        lastCorrectionMessage: message,
      });
      return;
    }
    if (noChanges && !isForkSession && !validationDisabled) {
      logger.info({ podId }, 'Completing pod directly — no files changed');
      emitActivityStatus(podId, 'No files changed — completing pod');
      await cleanupContainer(refreshed, 'no-changes-complete');
      const completedPod = transition(refreshed, 'complete', {
        completedAt: new Date().toISOString(),
        lastCorrectionMessage: null,
      });
      emitPodCompletedEvent(completedPod, 0);
      maybeTriggerDependents(completedPod);
      return;
    }

    if ((!forceSandboxValidation && validationDisabled) || (noChanges && !isForkSession)) {
      if (noChanges) {
        logger.info({ podId }, 'Skipping validation — no files changed');
        emitActivityStatus(podId, 'No files changed — skipping validation');
      } else if (getPodValidationSuite(refreshed) === 'off') {
        emitActivityStatus(podId, 'Validation suite is off — marking pod validated');
      }
      transition(refreshed, 'validating');
      const s2 = podRepo.getOrThrow(podId);
      const skippedPod = transition(s2, 'validated', { lastCorrectionMessage: null });
      maybeTriggerDependents(skippedPod);
      return;
    }

    // Trigger validation
    await triggerValidation(podId);
  }

  return { applyCompletionDecision };
}
