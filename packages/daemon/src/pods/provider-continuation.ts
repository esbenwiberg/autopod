import type {
  OperatorActor,
  Pod,
  ProviderFailoverTarget,
  ProviderFailureClassification,
} from '@autopod/shared';
import { AutopodError, PROVIDER_FAILOVER_HANDOFF_PATH } from '@autopod/shared';
import type { ContinuationCaptured, ContinuationLiveDependencies } from './continuation-ports.js';
import { writeProviderFailoverHandoff } from './recovery-context.js';
import { workerBindingHash } from './worker-retry-history.js';

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
    if (!pod.worktreePath || !worktreeManager.ensureExcludes) {
      throw new Error('Provider handoff exclusion protection is unavailable');
    }
    await worktreeManager.ensureExcludes(pod.worktreePath, [PROVIDER_FAILOVER_HANDOFF_PATH]);
    await writeProviderFailoverHandoff(
      pod,
      pod.worktreePath,
      classification,
      visibleProviderHandoffActivity(pod.id),
    );
  }

  async function queueProviderContinuation(
    pod: Pod,
    target: ProviderFailoverTarget,
    classification: ProviderFailureClassification,
    deferUntilCurrentRunExits = false,
    handoffPrepared = false,
  ): Promise<void> {
    if (!handoffPrepared) {
      await prepareProviderContinuationHandoff(pod, classification);
    }
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
  ): Promise<void> {
    const source = podRepo.getOrThrow(podId);
    try {
      await runtimeRegistry.get(source.runtime).abort(podId);
    } catch (err) {
      logger.warn({ err, podId }, 'Provider-limit runtime drain failed; pausing');
      return;
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
      } catch (err) {
        logger.warn({ err, podId }, 'Provider-limit worktree synchronization failed; pausing');
        return;
      }
    }
    if (source.containerId) {
      const cm = containerManagerFactory.get(source.executionTarget);
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await stopSandboxPreviewProxy(source.id);
        await stopHaproxyDenyReceiver(source.id);
        await Promise.race([
          cm.kill(source.containerId),
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(
              () => reject(new Error('Provider-limit container teardown timed out')),
              CONTAINER_CLEANUP_TIMEOUT_MS,
            );
          }),
        ]);
      } catch (err) {
        logger.warn({ err, podId }, 'Provider-limit container teardown could not be proven');
        return;
      } finally {
        if (timer) clearTimeout(timer);
      }
      forgetMaxCredentialLineage(source.id);
    }
    podRepo.update(podId, { containerId: null });
    const selection = selectProviderFailoverTarget(podRepo.getOrThrow(podId));
    if (!selection.target) {
      emitActivityStatus(podId, providerFailoverUnavailableActivity(selection));
      return;
    }
    try {
      await queueProviderContinuation(
        podRepo.getOrThrow(podId),
        selection.target,
        classification,
        true,
      );
    } catch (err) {
      logger.warn({ err, podId }, 'Automatic provider continuation failed closed');
      emitActivityStatus(podId, 'Provider limit reached — automatic continuation is unsafe');
    }
  }

  async function continueProvider(
    podId: string,
    requestedTarget?: ProviderFailoverTarget | 'profile-primary',
    actor: OperatorActor = { type: 'automation', id: 'direct-pod-manager' },
  ): Promise<{ action: 'same-provider' | 'alternate-provider' | 'primary-provider' }> {
    assertExecutionTerminationVerified(podId);
    const pod = podRepo.getOrThrow(podId);
    if (podRepo.taskExecutions?.hasActiveRun(podId))
      throw new AutopodError(
        'A worker in this task must settle before provider continuation',
        'TASK_AGENT_RUN_ACTIVE',
        409,
      );
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
      const resolved = profileStore.resolveProviderFailover(pod.profileName);
      const policy = resolved.policy;
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
        await syncWorkspaceBack(
          pod.containerId,
          pod.worktreePath,
          containerManagerFactory.get(pod.executionTarget),
          pod.id,
          pod.executionTarget,
        );
        await stopSandboxPreviewProxy(pod.id);
        await stopHaproxyDenyReceiver(pod.id);
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
        forgetMaxCredentialLineage(pod.id);
        podRepo.update(podId, { containerId: null });
      } catch (err) {
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
  };
}
