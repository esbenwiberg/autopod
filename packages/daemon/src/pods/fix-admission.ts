import type { EffectiveLaunchConfig, Pod } from '@autopod/shared';
import {
  AutopodError,
  DEFAULT_MAX_PR_FIX_ATTEMPTS,
  PodNotFoundError,
  generatePodId,
} from '@autopod/shared';
import { launchPodOptions } from '../configuration/launch-pod-options.js';
import type { PrMergeStatus } from '../interfaces/index.js';
import type { FixAdmissionCaptured, FixAdmissionLiveDependencies } from './fix-contracts.js';
import { FIX_DELIVERY_FAILED_PREFIX } from './fix-policy.js';
export function createFixAdmission(
  deps: FixAdmissionLiveDependencies,
  captured: FixAdmissionCaptured,
) {
  const {
    podRepo,
    logger,
    isFixCycleTerminal,
    emitActivityStatus,
    isFixPodRecyclable,
    transition,
    stopMergePolling,
    executionForPod,
    resolveBranchSource,
    cleanupContainer,
    providerBindingForFixPod,
    enqueueSession,
    eventBus,
  } = captured;
  const maybeSpawnFixSession = async (
    parentSessionId: string,
    _status: PrMergeStatus,
  ): Promise<void> => {
    // Re-read from DB to avoid stale closure state across 60s intervals
    const parent = podRepo.getOrThrow(parentSessionId);

    // Guard: fix pods must never spawn sub-fixers.
    // The root parent's merge poller owns all fix-spawn decisions.
    if (parent.linkedPodId) {
      logger.debug({ podId: parentSessionId }, 'Fix pod — skipping sub-fixer spawn');
      return;
    }

    // Guard: parent already terminal — nothing to fix. The API surfaces
    // `parent_terminal` to the user; the poller simply has nothing to do.
    if (isFixCycleTerminal(parent.status)) {
      logger.debug(
        { podId: parentSessionId, status: parent.status },
        'Parent pod terminal — skipping fix-pod spawn',
      );
      return;
    }

    // Guard: a fix pod is already alive AND making progress. The queue already
    // holds the new message; the running iteration drains it on
    // completion-and-recycle. A fix pod in `merge_pending` is the exception:
    // its pushed fix didn't unblock the PR, so we treat it as recyclable
    // (see `isFixPodRecyclable`) rather than waiting indefinitely for a state
    // change that won't come on its own.
    let recycleCandidate: Pod | null = null;
    if (parent.fixPodId) {
      try {
        const fix = podRepo.getOrThrow(parent.fixPodId);
        if (fix.linkedPodId !== parent.id)
          throw new AutopodError(
            'Canonical PR fix child belongs to a different parent',
            'CONFIG_SOURCE_CHANGED',
            409,
          );
        if (
          fix.status === 'awaiting_input' &&
          fix.mergeBlockReason?.startsWith(FIX_DELIVERY_FAILED_PREFIX)
        ) {
          logger.info(
            { podId: parentSessionId, fixPodId: fix.id, mergeBlockReason: fix.mergeBlockReason },
            'Fix pod delivery failed — suppressing automatic AI retry',
          );
          emitActivityStatus(
            parentSessionId,
            `Fix pod ${fix.id} validated but could not push — awaiting operator retry`,
          );
          return;
        }
        if (!isFixPodRecyclable(fix.status)) {
          logger.debug(
            { podId: parentSessionId, fixPodId: parent.fixPodId },
            'Fix pod already active — message queued for next iteration',
          );
          return;
        }
        recycleCandidate = fix;
      } catch (error) {
        if (!(error instanceof PodNotFoundError)) throw error;
        // Fix pod row gone — treat as no live fix pod, fall through to spawn.
      }
    }

    // Guard: max retries exhausted
    const maxAttempts = parent.maxPrFixAttempts ?? DEFAULT_MAX_PR_FIX_ATTEMPTS;
    if ((parent.prFixAttempts ?? 0) >= maxAttempts) {
      emitActivityStatus(
        parentSessionId,
        `Max PR fix attempts (${maxAttempts}) exhausted — pod failed`,
      );
      transition(parent, 'failed', {
        mergeBlockReason: `Max PR fix attempts (${maxAttempts}) exhausted`,
      });
      stopMergePolling(parentSessionId);
      logger.warn(
        { podId: parentSessionId, attempts: parent.prFixAttempts },
        'Fix-pod spawn: max fix attempts exhausted — pod failed',
      );
      return;
    }

    const profile = executionForPod(parent);
    const newAttempt = (parent.prFixAttempts ?? 0) + 1;

    // In a single-PR series, all pods share the root's branch but only the
    // PR-owning pod has prUrl set. The triggering pod's `branch` field can
    // diverge from the PR's actual source branch, so resolve the PR owner
    // and take branch/baseBranch/prUrl from it. Other prModes own their own
    // PR per pod, so the parent's fields are correct.
    const branchSource = resolveBranchSource(parent);

    // Recycle the terminal fix pod via the legal `complete|failed|killed →
    // queued` transition rather than creating a new child — keeps the "one fix
    // pod per PR" invariant the UI shows. The task is intentionally NOT set
    // here: it is built from the drained queue when the pod starts (see
    // `processPod`), so it picks up every message queued between now and start.
    if (recycleCandidate) {
      const fixPodId = recycleCandidate.id;
      const newIteration = (recycleCandidate.fixIteration ?? 0) + 1;

      // Terminal-state fix pods already had their merge poller stopped and
      // container reaped on the way in. A `merge_pending` fix pod, by contrast,
      // still has a live poller (60s interval) and may have left a container
      // behind — clean both up before flipping the row back to `queued` so the
      // poller's next tick doesn't observe the transition mid-flight.
      if (recycleCandidate.status === 'merge_pending') {
        stopMergePolling(fixPodId);
        await cleanupContainer(recycleCandidate, 'fix-pod-recycle');
      }

      transition(recycleCandidate, 'queued', {
        ...providerBindingForFixPod(recycleCandidate),
        containerId: null,
        worktreePath: null,
        validationAttempts: 0,
        lastValidationResult: null,
        lastCorrectionMessage: null,
        pendingEscalation: null,
        escalationCount: 0,
        startedAt: null,
        completedAt: null,
        claudeSessionId: null,
        codexSessionId: null,
        piSessionId: null,
        preSubmitReview: null,
        // report_task_summary is locked-on-first-write in pod-bridge-impl,
        // so the recycled fix pod must drop the prior round's summary to let
        // the new run record its own.
        taskSummary: null,
        fixIteration: newIteration,
        baseBranch: branchSource.baseBranch ?? null,
        prUrl: branchSource.prUrl ?? null,
      });

      podRepo.update(parentSessionId, {
        prFixAttempts: newAttempt,
        mergeBlockReason: `Fix attempt ${newAttempt}/${maxAttempts} in progress (pod ${fixPodId})`,
      });

      enqueueSession(fixPodId);
      emitActivityStatus(
        parentSessionId,
        `Re-enqueued fix pod ${fixPodId} (iteration ${newIteration}, attempt ${newAttempt}/${maxAttempts})`,
      );
      logger.info(
        { podId: parentSessionId, fixPodId, iteration: newIteration, attempt: newAttempt },
        'Fix-pod spawn: recycled fix pod for new failures',
      );
      return;
    }

    // No fix pod row yet — create the canonical one for this parent PR. The
    // task is a placeholder; the real task is built from the drained queue
    // when the pod starts.
    const placeholderTask = '[PR FIX] Awaiting queued feedback.';
    const inheritedProviderBinding = providerBindingForFixPod(parent);
    let insertedFix = false;
    const insertFix = (config?: EffectiveLaunchConfig): string => {
      for (let attempt = 0; attempt < 10; attempt++) {
        const fixId = generatePodId();
        try {
          podRepo.insert({
            id: fixId,
            profileName: config?.profileId ?? parent.profileName,
            dispatchRepository: config
              ? (config.repository?.config.remote ?? null)
              : profile.repoUrl,
            task: config?.task ?? placeholderTask,
            status: 'queued',
            model: parent.model,
            runtime: parent.runtime,
            ...inheritedProviderBinding,
            executionTarget: parent.executionTarget,
            branch: branchSource.branch,
            userId: parent.userId,
            maxValidationAttempts:
              config?.workflow.maxValidationAttempts ?? profile.maxValidationAttempts ?? 3,
            skipValidation: false,
            options: config ? launchPodOptions(config) : parent.options,
            outputMode: parent.outputMode,
            baseBranch: branchSource.baseBranch ?? null,
            linkedPodId: parent.id,
            pimGroups: parent.pimGroups ?? null,
            prUrl: branchSource.prUrl ?? null,
          });
          insertedFix = true;
          return fixId;
        } catch (err: unknown) {
          if (
            err instanceof Error &&
            err.message.includes('UNIQUE constraint failed') &&
            attempt < 9
          ) {
            continue;
          }
          throw err;
        }
      }
      throw new AutopodError('Unable to allocate a fix pod identity', 'POD_ID_CONFLICT', 409);
    };
    let fixId: string;
    if (parent.launchConfigDigest) {
      if (!deps.launchConfiguration?.admitDerived)
        throw new AutopodError(
          'Frozen fix-pod admission is unavailable',
          'CONFIG_EXECUTION_UNAVAILABLE',
          503,
        );
      fixId = await deps.launchConfiguration.admitDerived(
        {
          source: { podId: parent.id, digest: parent.launchConfigDigest, kind: 'fix' },
          fixAttempt: newAttempt,
          task: placeholderTask,
          work: {
            branch: branchSource.branch,
            baseBranch: branchSource.baseBranch ?? profile.defaultBranch ?? 'main',
            linkedPodId: parent.id,
            dependsOnPodIds: [],
          },
        },
        insertFix,
      );
    } else fixId = insertFix();

    // A concurrent caller can replay this admission; only its creator publishes it.
    if (!insertedFix) return;
    enqueueSession(fixId);
    eventBus.emit({
      type: 'pod.created',
      timestamp: new Date().toISOString(),
      pod: {
        id: fixId,
        profileName: parent.profileName,
        task: placeholderTask,
        status: 'queued',
        model: parent.model,
        runtime: parent.runtime,
        duration: null,
        filesChanged: 0,
        createdAt: new Date().toISOString(),
      },
    });

    podRepo.update(parentSessionId, {
      prFixAttempts: newAttempt,
      fixPodId: fixId,
      mergeBlockReason: `Fix attempt ${newAttempt}/${maxAttempts} in progress (pod ${fixId})`,
    });

    emitActivityStatus(
      parentSessionId,
      `Spawned fix pod ${fixId} (attempt ${newAttempt}/${maxAttempts})`,
    );
    logger.info(
      { podId: parentSessionId, fixPodId: fixId, attempt: newAttempt },
      'Fix-pod spawn: spawned fix pod for actionable failures',
    );
  };
  return { maybeSpawnFixSession };
}
