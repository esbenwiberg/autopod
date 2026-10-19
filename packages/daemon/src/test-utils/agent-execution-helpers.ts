import type { AgentEvent } from '@autopod/shared';
import { vi } from 'vitest';
import { createAgentActivity } from '../pods/agent-activity.js';
import { createAgentEventConsumption } from '../pods/agent-event-consumption.js';
import type {
  AgentConsumerCaptured,
  AgentProcessCalls,
  AgentProcessCaptured,
} from '../pods/agent-execution-contracts.js';
import { createAgentProcessWorkflow } from '../pods/agent-process-workflow.js';
import { createAgentRunRegistry } from '../pods/agent-run-registry.js';
import { createProviderAttemptContext } from '../pods/provider-attempt-context.js';
import { createProvisioningFixture } from './provisioning-helpers.js';

export function createAgentExecutionFixture(disk = false) {
  const f = createProvisioningFixture(disk);
  const registry = createAgentRunRegistry();
  const activity = createAgentActivity(f.deps, { podRepo: f.podRepo, logger: f.deps.logger });
  const executionForPod: AgentConsumerCaptured['executionForPod'] = (pod) =>
    pod.profileSnapshot ?? f.profiles.get(pod.profileName);
  const attempts = createProviderAttemptContext(f.deps, {
    podRepo: f.podRepo,
    providerAccountStore: f.accounts,
    profileStore: f.profiles,
    executionForPod,
    activeAgentRuns: registry.activeAgentRuns,
  });
  const consumerCaptured = {
    ...registry,
    ...activity,
    ...attempts,
    podRepo: f.podRepo,
    pauseIntents: new Map<string, symbol>(),
    logger: f.deps.logger,
    eventBus: f.deps.eventBus,
    startCommitPolling: vi.fn(),
    stopCommitPolling: vi.fn(),
    emitActivityStatus: vi.fn(),
    transition: f.captured.transition,
    progressEventRepo: undefined,
    summarizeAgentCompletionBlocker: vi.fn(() => null),
    executionForPod,
    sanitizeFailureReason: vi.fn(() => 'Synthetic sanitized failure'),
    hasDurableAgentExecutionEvidence: vi.fn(() => false),
    syncSandboxRuntimeSessionState: f.sandbox.syncSandboxRuntimeSessionState,
    handleProviderLimit: vi.fn(async () => {}),
  } satisfies AgentConsumerCaptured;
  const consumer = createAgentEventConsumption(f.deps, consumerCaptured);
  const processCaptured = {
    podRepo: f.podRepo,
    logger: f.deps.logger,
    emitActivityStatus: consumerCaptured.emitActivityStatus,
    resolveEffectiveBoundProfile: attempts.resolveEffectiveBoundProfile,
    provisioningWorkflow: f.workflow(),
    runtimeRegistry: f.deps.runtimeRegistry,
    ensureProviderAttempt: attempts.ensureProviderAttempt,
    activeAgentRuns: registry.activeAgentRuns,
    touchHeartbeat: activity.touchHeartbeat,
    rotateProviderAttemptForFreshSegment: attempts.rotateProviderAttemptForFreshSegment,
    buildReworkTask: vi.fn(async () => 'Synthetic rework'),
    buildContinuationPrompt: vi.fn(async () => 'Synthetic continuation'),
    buildRecoveryTask: vi.fn(async () => 'Synthetic recovery'),
    recordContinuationProvenance: vi.fn(async () => {}),
    primeRuntimeForResume: vi.fn(async () => []),
    appendDecisionContext: vi.fn((_pod, task: string) => task),
    ownsLifecycle: (podId: string, generation: number, containerId: string | null) => {
      const current = f.podRepo.getOrThrow(podId);
      return (
        current.lifecycleGeneration === generation &&
        (containerId === null || current.containerId === containerId)
      );
    },
    persistRuntimeCredentialsForPod: vi.fn(async () => {}),
    preserveSandboxAfterAgentFailure: vi.fn(async () => {}),
    hasDurableAgentExecutionEvidence: consumerCaptured.hasDurableAgentExecutionEvidence,
    tryRecoverTransientSandboxFailure: vi.fn(async () => false),
    closeProviderAttempt: attempts.closeProviderAttempt,
    scheduleHostFetchRetry: vi.fn(),
    emitActivityError: vi.fn(),
    transition: f.captured.transition,
    escalationRepo: f.deps.escalationRepo,
    operatorErrorMessage: vi.fn(() => 'Synthetic operator failure'),
    containerManagerFactory: f.deps.containerManagerFactory,
    CONTAINER_CLEANUP_TIMEOUT_MS: 15_000,
  } satisfies AgentProcessCaptured;
  const calls = {
    consumeAgentEvents: vi.fn(consumer.consumeAgentEvents),
    handleCompletion: vi.fn(async () => {}),
    triggerValidation: vi.fn(async () => {}),
  } satisfies AgentProcessCalls;
  return {
    ...f,
    // Preserve accessors instead of snapshotting the open/reopened database handle.
    get db() {
      return f.db;
    },
    registry,
    activity,
    attempts,
    consumerCaptured,
    consumer,
    processCaptured,
    calls,
    process: () => createAgentProcessWorkflow(f.deps, processCaptured),
    running() {
      f.podRepo.update('prepare', { status: 'running', containerId: 'container-123' });
    },
  };
}

export async function* agentEvents(...events: AgentEvent[]): AsyncIterable<AgentEvent> {
  yield* events;
}

export const syntheticComplete = {
  type: 'complete',
  timestamp: '2026-10-19T00:00:00.000Z',
  result: 'Synthetic completed work',
  totalInputTokens: 2,
  totalOutputTokens: 3,
  costUsd: 0.01,
} as const satisfies AgentEvent;
