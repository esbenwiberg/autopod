import type { Pod } from '@autopod/shared';
import type { SandboxInfrastructureError } from '../containers/sandbox-api-client.js';
import { assertValidationMutationSettled } from './validation-recovery-policy.js';
export function sandboxInfrastructureFailure(
  error: SandboxInfrastructureError,
  phase: 'setup' | 'agent',
  safeAgentRestart: boolean,
  recoveryDisposition:
    | 'automatic_retry_scheduled'
    | 'automatic_retry_exhausted'
    | 'agent_execution_ambiguous'
    | 'sandbox_cleanup_unconfirmed',
  retryNotBefore: string | null,
): Pod['infrastructureFailure'] {
  return {
    source: error.source,
    code: error.code,
    phase,
    statusCode: error.statusCode,
    diagnostics: error.diagnostics,
    safeAgentRestart,
    recoveryDisposition,
    occurredAt: new Date().toISOString(),
    retryNotBefore,
  };
}

import { hasLatestPersistedAgentTerminalEventComplete } from './agent-execution-policy.js';
import type { OperatorFailurePhase } from './completion-diagnostics.js';
import { sandboxStartupRetryInput } from './sandbox-startup-admission.js';
import { TaskRetryBlockedError } from './task-retry-ledger.js';
import type {
  WorkspaceInfrastructureCaptured,
  WorkspaceInfrastructureLiveDependencies,
} from './workspace-contracts.js';

export function createWorkspaceInfrastructureRecovery(
  deps: WorkspaceInfrastructureLiveDependencies,
  captured: WorkspaceInfrastructureCaptured,
) {
  const {
    ownsLifecycle,
    podRepo,
    emitActivityStatus,
    containerManagerFactory,
    logger,
    closeProviderAttempt,
    killSidecarsForPod,
    destroyPodNetwork,
  } = captured;

  function hasDurableAgentExecutionEvidence(pod: Pod): boolean {
    if (
      pod.worktreeCompromised ||
      pod.claudeSessionId !== null ||
      pod.codexSessionId !== null ||
      pod.piSessionId !== null ||
      pod.inputTokens > 0 ||
      pod.outputTokens > 0 ||
      pod.costUsd > 0 ||
      pod.taskSummary !== null ||
      pod.lastValidationResult !== null ||
      pod.prUrl !== null ||
      hasLatestPersistedAgentTerminalEventComplete(deps.eventRepo, pod.id)
    ) {
      return true;
    }
    return (deps.providerAttemptRepo?.list(pod.id) ?? []).some(
      (attempt) =>
        attempt.nativeSessionId !== null ||
        attempt.inputTokens > 0 ||
        attempt.outputTokens > 0 ||
        attempt.costUsd > 0,
    );
  }

  async function tryRecoverTransientSandboxFailure(
    podId: string,
    capturedPod: Pod,
    runtimeEventObserved: boolean,
    error: SandboxInfrastructureError,
    phase: OperatorFailurePhase,
  ): Promise<boolean> {
    if (
      capturedPod.executionTarget !== 'sandbox' ||
      (phase !== 'setup' && phase !== 'agent') ||
      !ownsLifecycle(podId, capturedPod.lifecycleGeneration, null)
    ) {
      return false;
    }

    const validationOnlyRecovery = capturedPod.skipAgent;
    const durableEvidence = hasDurableAgentExecutionEvidence(capturedPod);
    // A fresh-container validation-only run deliberately carries the completed
    // agent's durable evidence forward. That evidence is not ambiguous for this
    // lifecycle: skipAgent fences processPod from starting or resuming an agent.
    // Treat a setup failure here like any other pre-agent transport failure and
    // preserve skipAgent across the fresh-sandbox retry.
    if (!validationOnlyRecovery && (runtimeEventObserved || durableEvidence)) {
      podRepo.update(podId, {
        infrastructureFailure: sandboxInfrastructureFailure(
          error,
          phase,
          false,
          'agent_execution_ambiguous',
          null,
        ),
      });
      return false;
    }
    const startupLedger = podRepo.sandboxStartupRetries;
    let exhausted = capturedPod.infrastructureRecoveryCount >= 1;
    if (startupLedger) {
      const input = sandboxStartupRetryInput(capturedPod);
      try {
        startupLedger.assertCanAdmit(
          podId,
          capturedPod.lifecycleGeneration,
          input.identity,
          input.bindingHash,
          [...(deps.sandboxInfrastructureRetryBackoffMs ?? [30_000])],
        );
        exhausted = false;
      } catch (admissionError) {
        if (!(admissionError instanceof TaskRetryBlockedError)) throw admissionError;
        exhausted = true;
        emitActivityStatus(podId, admissionError.message);
      }
    }
    if (exhausted) {
      podRepo.update(podId, {
        infrastructureFailure: sandboxInfrastructureFailure(
          error,
          phase,
          true,
          'automatic_retry_exhausted',
          null,
        ),
      });
      return false;
    }

    assertValidationMutationSettled(podRepo, podId);
    // Fence every stale lifecycle continuation before touching the sandbox identity.
    const recoveryGeneration = podRepo.incrementLifecycleGeneration(podId);
    const oldContainerId = capturedPod.containerId;
    let deleted = oldContainerId === null;
    if (oldContainerId) {
      try {
        await containerManagerFactory.get('sandbox').kill(oldContainerId);
        deleted = true;
      } catch (cleanupError) {
        logger.warn(
          { err: cleanupError, podId, containerId: oldContainerId },
          'Fresh sandbox recovery could not prove old sandbox deletion',
        );
      }
    }
    const current = podRepo.getOrThrow(podId);
    if (
      current.lifecycleGeneration !== recoveryGeneration ||
      current.containerId !== oldContainerId
    ) {
      return true;
    }
    if (!deleted) {
      podRepo.update(podId, {
        infrastructureFailure: sandboxInfrastructureFailure(
          error,
          phase,
          false,
          'sandbox_cleanup_unconfirmed',
          null,
        ),
      });
      return false;
    }

    const startupState = startupLedger?.state(podId);
    const delay = startupState?.backoffsMs?.[startupState.transientRetryCount] ?? 30_000;
    const retryNotBefore = new Date(Date.now() + delay).toISOString();
    closeProviderAttempt(podId, 'aborted');
    await killSidecarsForPod(podId);
    await destroyPodNetwork(podId);
    const afterCleanup = podRepo.getOrThrow(podId);
    if (
      afterCleanup.lifecycleGeneration !== recoveryGeneration ||
      afterCleanup.containerId !== oldContainerId
    ) {
      return true;
    }
    podRepo.update(podId, {
      containerId: null,
      recoveryWorktreePath: afterCleanup.worktreePath,
      infrastructureRecoveryCount: capturedPod.infrastructureRecoveryCount + 1,
      infrastructureFailure: sandboxInfrastructureFailure(
        error,
        phase,
        true,
        'automatic_retry_scheduled',
        retryNotBefore,
      ),
      failureReason: null,
      completedAt: null,
    });
    const queued = podRepo.getOrThrow(podId);
    if (queued.status !== 'queued') podRepo.update(podId, { status: 'queued' });
    emitActivityStatus(
      podId,
      'Azure sandbox was unavailable before agent execution; retrying within the task startup budget.',
    );
    if (deps.requeueSessionAfterCurrent) {
      deps.requeueSessionAfterCurrent(podId);
    } else {
      // Compatibility for injected test/legacy managers: defer until this active
      // processPod call has unwound, matching PodQueue.requeueAfterCurrent().
      setImmediate(() => deps.enqueueSession(podId));
    }
    return true;
  }
  return { hasDurableAgentExecutionEvidence, tryRecoverTransientSandboxFailure };
}
