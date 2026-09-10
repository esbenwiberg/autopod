import { AutopodError, type Pod, type Profile } from '@autopod/shared';
import type { ContainerManager } from '../interfaces/container-manager.js';
import { inspectExecutionPreflight } from './execution-preflight.js';
import type { ExecutionProvenanceLedger } from './execution-provenance-ledger.js';

/** Callers must not fail or release the lifecycle that superseded this continuation. */
export class AgentContinuationSupersededError extends AutopodError {
  constructor(
    message = 'Agent continuation was superseded; current work and decisions are retained.',
  ) {
    super(message, 'STALE_AGENT_CONTINUATION', 409);
  }
}

export async function preflightAgentContinuation(
  pod: Pod,
  containerId: string,
  deps: {
    containerManager: ContainerManager;
    readCurrent(): Pod;
    hasPendingDecision(): boolean;
    resolveProfile(pod: Pod): Profile;
    provenance?: ExecutionProvenanceLedger;
  },
): Promise<void> {
  const assertCurrent = (): Pod => {
    const current = deps.readCurrent();
    if (
      current.lifecycleGeneration !== pod.lifecycleGeneration ||
      current.containerId !== containerId ||
      current.status !== 'running' ||
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
    return current;
  };
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
