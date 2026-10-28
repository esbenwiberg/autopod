import { AutopodError, type Pod } from '@autopod/shared';
import type { ContainerManager } from '../interfaces/container-manager.js';
import type { PodExecutionSettings } from '../interfaces/pod-execution-settings.js';
import { inspectExecutionPreflight } from './execution-preflight.js';
import type { ExecutionProvenanceLedger } from './execution-provenance-ledger.js';
import type { PodRepository } from './pod-repository.js';
import { assertTaskExecutionTerminationVerified } from './task-execution-ledger.js';
import { assertValidationExecutionSettled } from './validation-recovery-policy.js';

/** Callers must not fail or release the lifecycle that superseded this continuation. */
export class AgentContinuationSupersededError extends AutopodError {
  constructor(
    message = 'Agent continuation was superseded; current work and decisions are retained.',
  ) {
    super(message, 'STALE_AGENT_CONTINUATION', 409);
  }
}

export function assertAgentContinuationCurrent(
  pod: Pod,
  containerId: string | null,
  deps: {
    readCurrent(): Pod;
    hasPendingDecision(): boolean;
    expectedStatus?: Pod['status'];
    assertAvailable?(): void;
  },
): Pod {
  deps.assertAvailable?.();
  const current = deps.readCurrent();
  if (
    current.lifecycleGeneration !== pod.lifecycleGeneration ||
    current.containerId !== containerId ||
    current.status !== (deps.expectedStatus ?? 'running') ||
    current.runtime !== pod.runtime ||
    current.model !== pod.model ||
    current.providerIdSnapshot !== pod.providerIdSnapshot ||
    current.providerAccountIdSnapshot !== pod.providerAccountIdSnapshot ||
    current.executionTarget !== pod.executionTarget ||
    current.worktreePath !== pod.worktreePath ||
    current.branch !== pod.branch ||
    current.baseBranch !== pod.baseBranch ||
    JSON.stringify(current.contract) !== JSON.stringify(pod.contract)
  )
    throw new AgentContinuationSupersededError();
  if (deps.hasPendingDecision())
    throw new AgentContinuationSupersededError(
      'An unanswered human decision blocks agent continuation; it remains actionable.',
    );
  assertValidationExecutionSettled(current);
  return current;
}

/** No credentials, probes or new worker may reach a stopped or replaced resource. */
export async function prepareRetainedAgentContinuation(
  pod: Pod,
  containerId: string,
  deps: {
    containerManager: ContainerManager;
    podRepo: Pick<
      PodRepository,
      'getOrThrow' | 'hasUnansweredDecision' | 'taskExecutions' | 'sourceAdoptions'
    >;
    resolveProfile(pod: Pod): PodExecutionSettings;
  },
): Promise<void> {
  const assertCurrent = () => {
    const current = assertAgentContinuationCurrent(pod, containerId, {
      assertAvailable: () => deps.podRepo.sourceAdoptions?.assertAvailable(pod.id),
      readCurrent: () => deps.podRepo.getOrThrow(pod.id),
      hasPendingDecision: () =>
        deps.podRepo.hasUnansweredDecision?.(pod.id) ??
        Boolean(deps.podRepo.getOrThrow(pod.id).pendingEscalation),
    });
    assertTaskExecutionTerminationVerified(deps.podRepo.taskExecutions, pod.id);
    deps.resolveProfile(current);
  };
  async function awaitCurrent<T>(operation: () => Promise<T>): Promise<T> {
    let result: T;
    try {
      result = await operation();
    } catch (error) {
      assertCurrent();
      throw error;
    }
    assertCurrent();
    return result;
  }
  assertCurrent();
  const status = await awaitCurrent(() => deps.containerManager.getStatus(containerId));
  if (status === 'running') return;
  if (status !== 'stopped')
    throw new AutopodError(
      `Retained continuation resource is ${status}; restore and verify the original resource before resuming.`,
      'CONTINUATION_RESOURCE_UNAVAILABLE',
      409,
    );
  await awaitCurrent(() => deps.containerManager.start(containerId, { assertCurrent }));
  const resumed = await awaitCurrent(() => deps.containerManager.getStatus(containerId));
  if (resumed !== 'running')
    throw new AutopodError(
      'Retained continuation resource was not observed Running; no credentials or worker were dispatched.',
      'CONTINUATION_RESOURCE_NOT_RUNNING',
      409,
    );
}

export async function preflightAgentContinuation(
  pod: Pod,
  containerId: string,
  deps: {
    containerManager: ContainerManager;
    readCurrent(): Pod;
    hasPendingDecision(): boolean;
    assertAvailable?(): void;
    resolveProfile(pod: Pod): PodExecutionSettings;
    provenance?: ExecutionProvenanceLedger;
  },
): Promise<void> {
  const assertCurrent = () => assertAgentContinuationCurrent(pod, containerId, deps);
  const current = assertCurrent();
  const evidence = await inspectExecutionPreflight(
    deps.containerManager,
    containerId,
    current,
    deps.resolveProfile(current),
    'coding',
  );
  // Probes await external infrastructure. Recheck ownership and the immutable
  // provider binding before retaining evidence or configuring another turn.
  deps.resolveProfile(assertCurrent());
  deps.provenance?.record(pod.id, pod.lifecycleGeneration, evidence);
  if (evidence.status === 'blocked') {
    const failure = evidence.diagnostics.find(
      (item) => item.code.startsWith('PREFLIGHT_') || item.code === 'STREAMING_EXEC_UNSUPPORTED',
    );
    throw new AutopodError(
      failure?.detail ?? 'Agent continuation preflight requires reconciliation',
      failure?.code ?? 'EXECUTION_PREFLIGHT_BLOCKED',
      409,
    );
  }
}
