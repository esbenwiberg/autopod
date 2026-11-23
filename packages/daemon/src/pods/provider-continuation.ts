import type {
  OperatorActor,
  Pod,
  ProviderFailoverTarget,
  ProviderFailureClassification,
} from '@autopod/shared';
import { AutopodError, PROVIDER_FAILOVER_HANDOFF_PATH } from '@autopod/shared';
import type { ContinuationCaptured, ContinuationLiveDependencies } from './continuation-ports.js';
import { assertNoInfrastructureBlocker } from './escalation-coordinator.js';
import {
  capturePreparedDependencySnapshot,
  logCaptureResult,
} from './prepared-dependency-snapshot.js';
import { writeProviderFailoverHandoff } from './recovery-context.js';
import { workerBindingHash } from './worker-retry-history.js';
import {
  recordWorkspacePreservationFailure,
  recordWorkspacePreserved,
} from './workspace-preservation-outcome.js';

type Captured = Pick<
  ContinuationCaptured,
  | 'podRepo'
  | 'profileStore'
  | 'providerAccountStore'
  | 'containerManagerFactory'
  | 'worktreeManager'
  | 'runtimeRegistry'
  | 'enqueueSession'
  | 'logger'
  | 'executionForPod'
  | 'assertExecutionTerminationVerified'
  | 'stopHaproxyDenyReceiver'
  | 'CONTAINER_CLEANUP_TIMEOUT_MS'
  | 'stopSandboxPreviewProxy'
  | 'closeProviderAttempt'
  | 'selectProviderFailoverTarget'
  | 'providerFailoverUnavailableActivity'
  | 'providerFailoverSkippedActivity'
  | 'providerFailoverPolicy'
  | 'profileForProviderTarget'
  | 'openProviderTargetAttempt'
  | 'forgetMaxCredentialLineage'
  | 'syncWorkspaceBack'
  | 'emitActivityStatus'
  | 'operatorErrorMessage'
  | 'transition'
>;

export function createProviderContinuation(deps: ContinuationLiveDependencies, captured: Captured) {
  const {
    podRepo,
    profileStore,
    providerAccountStore,
    containerManagerFactory,
    worktreeManager,
    runtimeRegistry,
    enqueueSession,
    logger,
    executionForPod,
    assertExecutionTerminationVerified,
    stopHaproxyDenyReceiver,
    CONTAINER_CLEANUP_TIMEOUT_MS,
    stopSandboxPreviewProxy,
    closeProviderAttempt,
    selectProviderFailoverTarget,
    providerFailoverUnavailableActivity,
    providerFailoverSkippedActivity,
    providerFailoverPolicy,
    profileForProviderTarget,
    openProviderTargetAttempt,
    forgetMaxCredentialLineage,
    syncWorkspaceBack,
    emitActivityStatus,
    operatorErrorMessage,
    transition,
  } = captured;

  function visibleProviderHandoffActivity(podId: string): string[] {
    const events = deps.eventRepo?.getForSession(podId, {
      type: 'pod.agent_activity',
      latest: 80,
    });
    if (!events) return [];
    return events.flatMap((stored) => {
      if (stored.payload.type !== 'pod.agent_activity') return [];
      const event = stored.payload.event;
      if (event.type === 'status') return [`Status: ${event.message}`];
      if (event.type === 'tool_use') {
        const outcome = event.output ? ` — ${event.output}` : '';
        return [`Tool outcome (${event.tool})${outcome}`];
      }
      return [];
    });
  }

  async function prepareProviderContinuationHandoff(
    pod: Pod,
    classification: ProviderFailureClassification,
  ): Promise<void> {
    assertNoInfrastructureBlocker(podRepo, pod.id);
    if (!pod.worktreePath || !worktreeManager.ensureExcludes) {
      throw new Error('Provider handoff exclusion protection is unavailable');
    }
    await worktreeManager.ensureExcludes(pod.worktreePath, [PROVIDER_FAILOVER_HANDOFF_PATH]);
    assertNoInfrastructureBlocker(podRepo, pod.id);
    await writeProviderFailoverHandoff(
      pod,
      pod.worktreePath,
      classification,
      visibleProviderHandoffActivity(pod.id),
    );
    assertNoInfrastructureBlocker(podRepo, pod.id);
  }

  /**
   * Save the torn-down container's prepared dependencies for the continuation (#644).
   * Best effort and self-bounded; it never fails or blocks the continuation beyond the
   * capture bound, and a skipped capture just means the next provisioning prepares in full.
   */
  async function capturePreparedDependencies(pod: Pod, containerId: string): Promise<void> {
    try {
      const provenance = podRepo.executionProvenance?.latest(pod.id) ?? null;
      const evidence = provenance?.repositoryPreparation;
      if (!evidence || evidence.status === 'not-configured') return;
      const result = await capturePreparedDependencySnapshot({
        podId: pod.id,
        executionTarget: pod.executionTarget,
        containerId,
        cm: containerManagerFactory.get(pod.executionTarget),
        evidence,
        imageDigest: provenance?.imageDigest ?? null,
      });
      emitActivityStatus(pod.id, logCaptureResult(logger, pod.id, result));
    } catch (err) {
      logger.warn({ err, podId: pod.id }, 'Prepared dependency snapshot capture failed');
    }
  }

  /**
   * Refuse a provider continuation the task ledger would refuse at spawn, before
   * opening the target attempt or spending another full preparation (#646).
   */
  function assertContinuationBudgetAdmissible(podId: string): void {
    const budget = podRepo.taskExecutions?.snapshot(podId).budgetCheck;
    if (budget?.status === 'exhausted')
      throw new AutopodError(
        `Provider continuation blocked: ${budget.reason}`,
        'TASK_BUDGET_EXHAUSTED',
        409,
      );
    if (budget?.status === 'unavailable')
      throw new AutopodError(
        `Provider continuation blocked: ${budget.reason}${
          budget.reason.startsWith('Task token accounting incomplete')
            ? ` Pod owner can run: ap accept-unmeasured-usage ${podId} --reason "<why>"`
            : ''
        }`,
        'TASK_BUDGET_UNAVAILABLE',
        409,
      );
  }

  async function queueProviderContinuation(
    pod: Pod,
    target: ProviderFailoverTarget,
    classification: ProviderFailureClassification,
    deferUntilCurrentRunExits = false,
    handoffPrepared = false,
  ): Promise<void> {
    assertNoInfrastructureBlocker(podRepo, pod.id);
    assertContinuationBudgetAdmissible(pod.id);
    if (!handoffPrepared) {
      await prepareProviderContinuationHandoff(pod, classification);
    }
    assertNoInfrastructureBlocker(podRepo, pod.id);
    const sourceAttempt = deps.providerAttemptRepo
      ?.list(pod.id)
      .findLast((attempt) => attempt.endedAt !== null);
    const preservesNativeSession =
      sourceAttempt?.providerAccountId === target.providerAccountId &&
      sourceAttempt.runtime === target.runtime &&
      sourceAttempt.model === target.model;
    const targetProfile = profileForProviderTarget(executionForPod(pod), target);
    const targetProvider = providerAccountStore?.get(target.providerAccountId).provider ?? null;
    openProviderTargetAttempt(pod, target);
    try {
      podRepo.update(pod.id, {
        runtime: target.runtime,
        model: target.model,
        providerAccountIdSnapshot: target.providerAccountId,
        providerIdSnapshot: targetProvider,
        containerId: null,
        recoveryWorktreePath: pod.worktreePath,
        pauseReason: null,
        failureReason: null,
        ...(!preservesNativeSession && {
          claudeSessionId: null,
          codexSessionId: null,
          piSessionId: null,
        }),
      });
      transition(podRepo.getOrThrow(pod.id), 'queued');
    } catch (err) {
      closeProviderAttempt(pod.id, 'aborted');
      podRepo.update(pod.id, {
        runtime: pod.runtime,
        model: pod.model,
        providerAccountIdSnapshot: pod.providerAccountIdSnapshot,
        providerIdSnapshot: pod.providerIdSnapshot,
        containerId: pod.containerId,
        recoveryWorktreePath: pod.recoveryWorktreePath,
        pauseReason: pod.pauseReason,
        failureReason: pod.failureReason,
        claudeSessionId: pod.claudeSessionId,
        codexSessionId: pod.codexSessionId,
        piSessionId: pod.piSessionId,
      });
      throw err;
    }
    if (deferUntilCurrentRunExits && deps.requeueSessionAfterCurrent) {
      deps.requeueSessionAfterCurrent(pod.id);
    } else {
      enqueueSession(pod.id);
    }
    emitActivityStatus(pod.id, `Provider continuation queued: ${target.runtime}/${target.model}`);
  }

  async function handleProviderLimit(
    podId: string,
    classification: ProviderFailureClassification,
  ): Promise<'queued' | 'budget_blocked' | 'not_queued'> {
    const source = podRepo.getOrThrow(podId);
    if (podRepo.hasInfrastructureBlocker?.(podId)) {
      emitActivityStatus(
        podId,
        'Infrastructure blocked — provider continuation cannot repair this execution',
      );
      return 'not_queued';
    }
    try {
      await runtimeRegistry.get(source.runtime).abort(podId);
      assertNoInfrastructureBlocker(podRepo, podId);
    } catch (err) {
      logger.warn({ err, podId }, 'Provider-limit runtime drain failed; pausing');
      return 'not_queued';
    }
    if (source.containerId && source.worktreePath) {
      try {
        await syncWorkspaceBack(
          source.containerId,
          source.worktreePath,
          containerManagerFactory.get(source.executionTarget),
          source.id,
          source.executionTarget,
        );
        assertNoInfrastructureBlocker(podRepo, podId);
      } catch (err) {
        logger.warn({ err, podId }, 'Provider-limit worktree synchronization failed; pausing');
        // The container is not torn down below; say so where the operator looks.
        if (!(err instanceof AutopodError && err.code === 'INFRASTRUCTURE_BLOCKED')) {
          recordWorkspacePreservationFailure(podRepo, podId, err);
          emitActivityStatus(
            podId,
            'Provider limit reached, but the workspace could not be preserved — the original container is retained as the only copy.',
          );
        }
        return 'not_queued';
      }
      // Only after the post-sync infrastructure fence: a hold admits no later effects.
      recordWorkspacePreserved(podRepo, source);
      await capturePreparedDependencies(source, source.containerId);
      assertNoInfrastructureBlocker(podRepo, podId);
    }
    if (source.containerId) {
      const cm = containerManagerFactory.get(source.executionTarget);
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await stopSandboxPreviewProxy(source.id);
        assertNoInfrastructureBlocker(podRepo, podId);
        await stopHaproxyDenyReceiver(source.id);
        assertNoInfrastructureBlocker(podRepo, podId);
        await Promise.race([
          cm.kill(source.containerId),
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(
              () => reject(new Error('Provider-limit container teardown timed out')),
              CONTAINER_CLEANUP_TIMEOUT_MS,
            );
          }),
        ]);
        assertNoInfrastructureBlocker(podRepo, podId);
      } catch (err) {
        logger.warn({ err, podId }, 'Provider-limit container teardown could not be proven');
        return 'not_queued';
      } finally {
        if (timer) clearTimeout(timer);
      }
      forgetMaxCredentialLineage(source.id);
    }
    podRepo.update(podId, { containerId: null });
    const selection = selectProviderFailoverTarget(podRepo.getOrThrow(podId));
    for (const line of providerFailoverSkippedActivity?.(selection) ?? [])
      emitActivityStatus(podId, line);
    if (!selection.target) {
      emitActivityStatus(podId, providerFailoverUnavailableActivity(selection));
      return 'not_queued';
    }
    try {
      await queueProviderContinuation(
        podRepo.getOrThrow(podId),
        selection.target,
        classification,
        true,
      );
      return 'queued';
    } catch (err) {
      if (
        err instanceof AutopodError &&
        (err.code === 'TASK_BUDGET_UNAVAILABLE' || err.code === 'TASK_BUDGET_EXHAUSTED')
      ) {
        // Parked before any target attempt or re-preparation; the reason names the attempt.
        logger.warn({ podId, code: err.code }, 'Provider continuation blocked by task budget');
        podRepo.update(podId, { failureReason: err.message });
        emitActivityStatus(podId, err.message);
        return 'budget_blocked';
      }
      logger.warn({ err, podId }, 'Automatic provider continuation failed closed');
      emitActivityStatus(podId, 'Provider limit reached — automatic continuation is unsafe');
      return 'not_queued';
    }
  }

  /**
   * After the pod owner accepted an attempt's usage as unmeasured, queue the
   * configured failover for a pod still parked on a provider limit. The budget
   * gate is re-checked by queueProviderContinuation.
   */
  async function continueAfterAcceptedUsage(
    podId: string,
  ): Promise<{ continuation: 'queued' | 'not_applicable' | 'unavailable'; message?: string }> {
    const pod = podRepo.getOrThrow(podId);
    if (pod.status !== 'paused' || pod.pauseReason !== 'provider_limit')
      return { continuation: 'not_applicable' };
    const source = deps.providerAttemptRepo
      ?.list(podId)
      .findLast((attempt) => attempt.endedAt !== null);
    const classification = source?.classification;
    if (!classification)
      return {
        continuation: 'unavailable',
        message: 'No classified provider attempt to continue from',
      };
    const selection = selectProviderFailoverTarget(pod);
    for (const line of providerFailoverSkippedActivity?.(selection) ?? [])
      emitActivityStatus(podId, line);
    if (!selection.target) {
      const message = providerFailoverUnavailableActivity(selection);
      emitActivityStatus(podId, message);
      return { continuation: 'unavailable', message };
    }
    try {
      await queueProviderContinuation(pod, selection.target, classification);
      return { continuation: 'queued' };
    } catch (err) {
      const message = operatorErrorMessage(err, 'agent');
      logger.warn({ err, podId }, 'Provider continuation after accepted usage failed closed');
      emitActivityStatus(podId, `Provider continuation after accepted usage failed: ${message}`);
      return { continuation: 'unavailable', message };
    }
  }

  async function continueProvider(
    podId: string,
    requestedTarget?: ProviderFailoverTarget | 'profile-primary',
    actor: OperatorActor = { type: 'automation', id: 'direct-pod-manager' },
  ): Promise<{ action: 'same-provider' | 'alternate-provider' | 'primary-provider' }> {
    assertExecutionTerminationVerified(podId);
    assertNoInfrastructureBlocker(podRepo, podId);
    const pod = podRepo.getOrThrow(podId);
    if (podRepo.taskExecutions?.hasActiveRun(podId))
      throw new AutopodError(
        'A worker in this task must settle before provider continuation',
        'TASK_AGENT_RUN_ACTIVE',
        409,
      );
    assertContinuationBudgetAdmissible(podId);
    const primaryRecovery = requestedTarget === 'profile-primary';
    const pausedProviderLimit = pod.status === 'paused' && pod.pauseReason === 'provider_limit';
    if (primaryRecovery && pod.status !== 'failed') {
      throw new AutopodError(
        'Profile-primary recovery is only available for failed pods',
        'INVALID_STATE',
        409,
      );
    }
    if (pod.status === 'failed' && !primaryRecovery) {
      throw new AutopodError(
        'Failed pods may only be continued on the profile primary provider',
        'INVALID_PROVIDER_TARGET',
        409,
      );
    }
    if (!pausedProviderLimit && !primaryRecovery) {
      throw new AutopodError(
        `Cannot continue provider for pod ${podId} outside a provider-limit pause`,
        'INVALID_STATE',
        409,
      );
    }
    if (!pod.worktreePath || pod.worktreeCompromised) {
      throw new AutopodError(
        `Pod ${podId} does not have a safe worktree for provider continuation`,
        'WORKTREE_COMPROMISED',
        409,
      );
    }
    const attempts = deps.providerAttemptRepo?.list(podId) ?? [];
    const strandedActive = attempts.find((attempt) => attempt.endedAt === null);
    const settledAttempts = attempts.filter((attempt) => attempt.endedAt !== null);
    const source = settledAttempts.findLast(
      (attempt) =>
        attempt.outcome === 'quota_exhausted' &&
        attempt.classification?.category === 'quota_exhausted' &&
        attempt.classification.definitive,
    );
    if (!source && !primaryRecovery) {
      throw new AutopodError(
        `Pod ${podId} has no definitive provider-limit evidence`,
        'PROVIDER_LIMIT_NOT_DEFINITIVE',
        409,
      );
    }
    const profile = executionForPod(pod);
    const target = primaryRecovery
      ? {
          providerAccountId: profile.providerAccountId ?? '',
          runtime: profile.defaultRuntime,
          model: profile.defaultModel ?? '',
        }
      : (requestedTarget ?? {
          providerAccountId: source?.providerAccountId,
          runtime: source?.runtime,
          model: source?.model,
        });
    if (!target.providerAccountId) {
      throw new AutopodError(
        primaryRecovery
          ? 'Profile primary recovery requires a configured provider account'
          : 'Same-provider continuation requires a provider account',
        'INVALID_PROVIDER_TARGET',
        409,
      );
    }
    profileForProviderTarget(profile, target);
    const sameProvider =
      source !== undefined &&
      target.providerAccountId === source.providerAccountId &&
      target.runtime === source.runtime &&
      target.model === source.model;
    if (sameProvider && !primaryRecovery) {
      const sameProviderAttempts = settledAttempts.filter(
        (attempt) =>
          attempt.outcome !== 'aborted' &&
          attempt.providerAccountId === target.providerAccountId &&
          attempt.runtime === target.runtime &&
          attempt.model === target.model,
      );
      if (sameProviderAttempts.length >= 2) {
        throw new AutopodError(
          'Same-provider continuation has already been attempted once',
          'PROVIDER_FAILOVER_HOP_LIMIT',
          409,
        );
      }
    } else if (!primaryRecovery) {
      const policy = providerFailoverPolicy
        ? providerFailoverPolicy(pod)
        : profileStore.resolveProviderFailover(pod.profileName).policy;
      const isConfigured = policy?.targets.some(
        (configured) =>
          configured.providerAccountId === target.providerAccountId &&
          configured.runtime === target.runtime &&
          configured.model === target.model,
      );
      const maxHops = policy
        ? Math.min(policy.maxHops ?? policy.targets.length, policy.targets.length)
        : 0;
      const attemptedTargets =
        policy?.targets.filter((configured) =>
          settledAttempts.some(
            (attempt) =>
              attempt.providerAccountId === configured.providerAccountId &&
              attempt.runtime === configured.runtime &&
              attempt.model === configured.model,
          ),
        ) ?? [];
      if (!isConfigured || attemptedTargets.length >= maxHops) {
        throw new AutopodError(
          'Provider target is not authorized by the effective failover policy',
          'INVALID_PROVIDER_TARGET',
          409,
        );
      }
      const used = settledAttempts.some(
        (attempt) =>
          attempt.providerAccountId === target.providerAccountId &&
          attempt.runtime === target.runtime &&
          attempt.model === target.model,
      );
      if (used) {
        throw new AutopodError(
          'Provider target was already attempted for this pod',
          'PROVIDER_FAILOVER_LOOP',
          409,
        );
      }
    }
    const retryState = podRepo.workerRetries?.state(podId);
    if (retryState?.retryFailure && retryState.latest) {
      const targetBindingHash = workerBindingHash({
        runtime: target.runtime,
        model: target.model,
        providerAccountId: target.providerAccountId,
      });
      assertNoInfrastructureBlocker(podRepo, podId);
      podRepo.workerRetries?.authorize(
        podId,
        `provider-recovery:${podId}:${retryState.latest.id}:${targetBindingHash}`,
        `Operator selected ${target.runtime}/${target.model} on account ${target.providerAccountId} after worker failure.`,
        actor,
        targetBindingHash,
      );
    }
    if (pod.containerId) {
      try {
        await runtimeRegistry.get(pod.runtime).abort(podId);
        assertNoInfrastructureBlocker(podRepo, podId);
        try {
          await syncWorkspaceBack(
            pod.containerId,
            pod.worktreePath,
            containerManagerFactory.get(pod.executionTarget),
            pod.id,
            pod.executionTarget,
          );
        } catch (err) {
          if (pod.worktreePath) recordWorkspacePreservationFailure(podRepo, podId, err);
          throw err;
        }
        assertNoInfrastructureBlocker(podRepo, podId);
        await capturePreparedDependencies(pod, pod.containerId);
        assertNoInfrastructureBlocker(podRepo, podId);
        await stopSandboxPreviewProxy(pod.id);
        assertNoInfrastructureBlocker(podRepo, podId);
        await stopHaproxyDenyReceiver(pod.id);
        assertNoInfrastructureBlocker(podRepo, podId);
        const cm = containerManagerFactory.get(pod.executionTarget);
        let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            cm.kill(pod.containerId),
            new Promise<never>((_resolve, reject) => {
              cleanupTimer = setTimeout(
                () => reject(new Error('Provider continuation teardown timed out')),
                CONTAINER_CLEANUP_TIMEOUT_MS,
              );
            }),
          ]);
        } finally {
          if (cleanupTimer) clearTimeout(cleanupTimer);
        }
        assertNoInfrastructureBlocker(podRepo, podId);
        forgetMaxCredentialLineage(pod.id);
        podRepo.update(podId, { containerId: null });
        // Record the preservation receipt only once teardown committed the continuation:
        // a rejected continuation must leave the pod unchanged.
        if (pod.worktreePath) recordWorkspacePreserved(podRepo, pod);
      } catch (err) {
        if (err instanceof AutopodError && err.code === 'INFRASTRUCTURE_BLOCKED') throw err;
        throw new AutopodError(
          `Provider continuation could not safely drain the source runtime: ${operatorErrorMessage(err, 'agent')}`,
          'PROVIDER_CONTINUATION_UNSAFE',
          409,
        );
      }
    }
    try {
      await prepareProviderContinuationHandoff(
        podRepo.getOrThrow(podId),
        source?.classification ?? {
          category: 'unknown',
          definitive: false,
          sanitizedMessage: 'Operator requested recovery on the profile primary provider',
        },
      );
    } catch (err) {
      if (err instanceof AutopodError && err.code === 'INFRASTRUCTURE_BLOCKED') throw err;
      throw new AutopodError(
        `Provider continuation could not safely prepare its handoff: ${operatorErrorMessage(err, 'agent')}`,
        'PROVIDER_CONTINUATION_UNSAFE',
        409,
      );
    }
    if (strandedActive) {
      closeProviderAttempt(podId, 'aborted');
      if (!primaryRecovery && source) {
        podRepo.update(podId, {
          runtime: source.runtime,
          model: source.model,
          pauseReason: 'provider_limit',
        });
      }
    }
    await queueProviderContinuation(
      podRepo.getOrThrow(podId),
      target,
      source?.classification ?? {
        category: 'unknown',
        definitive: false,
        sanitizedMessage: 'Operator requested recovery on the profile primary provider',
      },
      false,
      true,
    );
    return {
      action: primaryRecovery
        ? 'primary-provider'
        : sameProvider
          ? 'same-provider'
          : 'alternate-provider',
    };
  }

  return {
    visibleProviderHandoffActivity,
    prepareProviderContinuationHandoff,
    queueProviderContinuation,
    handleProviderLimit,
    continueProvider,
    continueAfterAcceptedUsage,
  };
}
