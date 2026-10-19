import { setTimeout as sleep } from 'node:timers/promises';
import type { AgentEvent, Pod, ProviderFailureClassification } from '@autopod/shared';
import { AutopodError, PROVIDER_FAILOVER_HANDOFF_PATH } from '@autopod/shared';
import { SandboxInfrastructureError } from '../containers/sandbox-api-client.js';
import { atomicPodChange } from '../db/unit-of-work.js';
import type { PodExecutionSettings } from '../interfaces/pod-execution-settings.js';
import type { AgentRunOutcome } from './agent-execution-contracts.js';
import type {
  AgentConsumerCaptured,
  AgentExecutionLiveDependencies,
} from './agent-execution-contracts.js';
import {
  agentCompleteEventKey,
  agentPhaseBucketKey,
  hasAlreadyCountedCompleteEvent,
  persistedAgentCompleteEventKeys,
} from './agent-execution-policy.js';
import type { PodUpdates } from './pod-repository.js';
import { nativeSessionId } from './provider-attempt-policy.js';
import { ProviderAttemptSupersededError } from './provider-attempt-repository.js';
import { waitForRetryBackoff } from './retry-backoff-wait.js';
import { canFail } from './state-machine.js';
import { TaskRetryBlockedError } from './task-retry-ledger.js';
import { workerRetryDeadline } from './worker-retry-deadline.js';
import {
  WORKER_RETRY_BACKOFFS_MS,
  unavailableWorkerInputs,
  workerBindingHash,
} from './worker-retry-history.js';

export function createAgentEventConsumption(
  deps: Pick<
    AgentExecutionLiveDependencies,
    | 'launchConfiguration'
    | 'providerAttemptRepo'
    | 'workerInfrastructureRetryBackoffMs'
    | 'eventRepo'
    | 'workerInfrastructureRetryDelay'
  >,
  captured: AgentConsumerCaptured,
) {
  const {
    podRepo,
    activeAgentRunResolvers,
    activeAgentRuns,
    resolveEffectiveBoundProfile,
    ensureProviderAttempt,
    startCommitPolling,
    pauseIntents,
    logger,
    eventBus,
    bumpActivityTimestamp,
    emitActivityStatus,
    transition,
    progressEventRepo,
    rotateProviderAttemptForFreshSegment,
    summarizeAgentCompletionBlocker,
    executionForPod,
    sanitizeFailureReason,
    touchHeartbeat,
    hasDurableAgentExecutionEvidence,
    syncSandboxRuntimeSessionState,
    closeProviderAttempt,
    handleProviderLimit,
    stopCommitPolling,
    lastEventWriteAt,
  } = captured;

  async function consumeAgentEvents(
    podId: string,
    events: AsyncIterable<AgentEvent>,
    attempt = 0,
    lifecycle?: { generation: number; containerId: string | null; nativeGoal?: boolean },
  ): Promise<AgentRunOutcome> {
    const initialPod = podRepo.getOrThrow(podId);
    if (deps.launchConfiguration?.read(podId)?.intent === 'goal' && !lifecycle?.nativeGoal)
      throw new AutopodError(
        'Native Goals must resume through their native lifecycle',
        'GOAL_NATIVE_RESUME_REQUIRED',
        409,
      );
    const expected = lifecycle
      ? { ...lifecycle }
      : {
          generation: initialPod.lifecycleGeneration,
          containerId: initialPod.containerId,
        };
    const ownsExpectedLifecycle = (): boolean => {
      try {
        const current = podRepo.getOrThrow(podId);
        return (
          current.lifecycleGeneration === expected.generation &&
          current.containerId === expected.containerId &&
          current.runtime === initialPod.runtime &&
          current.model === initialPod.model &&
          current.providerIdSnapshot === initialPod.providerIdSnapshot &&
          current.providerAccountIdSnapshot === initialPod.providerAccountIdSnapshot &&
          current.executionTarget === initialPod.executionTarget &&
          current.worktreePath === initialPod.worktreePath
        );
      } catch {
        return false;
      }
    };
    if (!ownsExpectedLifecycle()) return 'stopped';
    const runToken = Symbol(podId);
    let resolveRunSettled: () => void = () => {};
    const runSettled = new Promise<void>((resolve) => {
      resolveRunSettled = resolve;
    });
    const runOwner: {
      token: symbol;
      settled: Promise<void>;
      providerOrdinal?: number;
      taskRunId?: string;
      isCurrent?: () => boolean;
    } = {
      token: runToken,
      settled: runSettled,
    };
    const settleActiveRun = (): void => {
      resolveRunSettled();
      const activeResolver = activeAgentRunResolvers.get(podId);
      if (activeResolver?.token !== runToken) return;
      activeAgentRunResolvers.delete(podId);
      activeAgentRuns.delete(podId);
    };
    const ownsRun = () =>
      activeAgentRuns.get(podId)?.token === runToken &&
      ownsExpectedLifecycle() &&
      (!deps.providerAttemptRepo ||
        (runOwner.providerOrdinal !== undefined &&
          deps.providerAttemptRepo.getActive(podId)?.ordinal === runOwner.providerOrdinal));
    runOwner.isCurrent = ownsRun;
    let superseded = false;
    let eventError: unknown;
    let hasEventError = false;
    let attemptPod: Pod;
    let attemptProfile: PodExecutionSettings;
    let seenCompleteEvents: Set<string>;
    let taskRunId: string | undefined;
    let workerAdmissionId: string | undefined;
    let workerStartedAt: number | undefined;
    let workerNotBefore: string | undefined;
    try {
      const initialized = atomicPodChange(podRepo, () => {
        const currentPod = podRepo.getOrThrow(podId);
        const currentProfile = resolveEffectiveBoundProfile(currentPod);
        podRepo.completionJournal?.begin(currentPod);
        let runId: string | undefined;
        if (podRepo.taskExecutions) {
          podRepo.taskExecutions.register(podId);
          const cycle = podRepo.completionJournal?.get(
            podId,
            currentPod.lifecycleGeneration,
          )?.cycle;
          if (cycle === undefined)
            throw new Error('Task execution requires a durable completion cycle');
          runId = podRepo.taskExecutions.beginRun(podId, currentPod.lifecycleGeneration, cycle, {
            runtime: currentPod.runtime,
            model: currentPod.model,
            providerAccountId: currentProfile.providerAccountId ?? null,
            resource: {
              containerId: currentPod.containerId,
              executionTarget: currentPod.executionTarget,
            },
          });
        }
        const workerAdmission = runId
          ? podRepo.workerRetries?.admit(
              podId,
              currentPod.lifecycleGeneration,
              unavailableWorkerInputs,
              workerBindingHash({
                runtime: currentPod.runtime,
                model: currentPod.model,
                providerAccountId: currentProfile.providerAccountId ?? null,
              }),
              [...(deps.workerInfrastructureRetryBackoffMs ?? WORKER_RETRY_BACKOFFS_MS)],
              runId,
            )
          : undefined;
        const providerOrdinal = ensureProviderAttempt(currentPod, currentProfile)?.ordinal;
        return { currentPod, currentProfile, runId, providerOrdinal, workerAdmission };
      });
      attemptPod = initialized.currentPod;
      attemptProfile = initialized.currentProfile;
      taskRunId = initialized.runId;
      runOwner.taskRunId = taskRunId;
      workerAdmissionId = initialized.workerAdmission?.id;
      workerNotBefore = initialized.workerAdmission?.notBefore;
      runOwner.providerOrdinal = initialized.providerOrdinal;
      seenCompleteEvents = persistedAgentCompleteEventKeys(deps.eventRepo, podId);
      activeAgentRuns.set(podId, runOwner);
      activeAgentRunResolvers.set(podId, { token: runToken, resolve: resolveRunSettled });
      startCommitPolling(podId);
    } catch (err) {
      if (taskRunId) podRepo.taskExecutions?.finishRun(taskRunId, 'failed', 'initialization');
      if (workerAdmissionId) podRepo.workerRetries?.finish(workerAdmissionId, 'unknown', null);
      settleActiveRun();
      throw err;
    }
    // Legacy/injected managers without the ledger retain the historical empty-stream
    // completion behavior. Production always injects the ledger and fails closed.
    let outcome: AgentRunOutcome = deps.providerAttemptRepo ? 'failed' : 'completed';
    let observedTerminalOutcome: 'completed' | 'failed' | null = null;
    let terminalClassification: ProviderFailureClassification | null = null;
    let executionTerminationUnverified = false;
    let workerEventObserved = false;
    let providerRetryNotBefore: string | null = null;
    const retainUnverifiedTermination = () => {
      executionTerminationUnverified = true;
      if (taskRunId) podRepo.taskExecutions?.retainUnverifiedRun(taskRunId);
    };
    try {
      if (!ownsRun()) {
        outcome = 'stopped';
        return outcome;
      }
      if (workerNotBefore && Date.parse(workerNotBefore) > Date.now()) {
        await waitForRetryBackoff(
          workerNotBefore,
          deps.workerInfrastructureRetryDelay ?? sleep,
          () => {
            if (!ownsRun() || pauseIntents.has(podId))
              throw new TaskRetryBlockedError(
                'Worker admission was cancelled or superseded during cooldown',
              );
          },
        );
        if (!ownsRun() || pauseIntents.has(podId))
          throw new TaskRetryBlockedError(
            'Worker admission was cancelled or superseded before execution',
          );
        resolveEffectiveBoundProfile(podRepo.getOrThrow(podId));
      }
      if (workerAdmissionId) podRepo.workerRetries?.start(workerAdmissionId);
      workerStartedAt = performance.now();
      for await (const event of events) {
        workerEventObserved = true;
        if (!ownsRun()) {
          logger.info(
            { podId, containerId: expected.containerId, generation: expected.generation },
            'Stopped processing stale lifecycle agent events',
          );
          outcome = 'stopped';
          return outcome;
        }
        if (pauseIntents.has(podId)) {
          outcome = 'paused';
          continue;
        }
        if (event.type === 'complete') {
          const completeKey = agentCompleteEventKey(event);
          if (
            seenCompleteEvents.has(completeKey) &&
            hasAlreadyCountedCompleteEvent(podRepo.getOrThrow(podId), attempt, event)
          ) {
            logger.info(
              { podId, timestamp: event.timestamp },
              'Skipping duplicate agent complete event replay',
            );
            continue;
          }
          seenCompleteEvents.add(completeKey);
        }

        eventBus.emit({
          type: 'pod.agent_activity',
          timestamp: event.timestamp,
          podId,
          event,
        });

        bumpActivityTimestamp(podId);

        if (event.type === 'escalation') {
          const pod = podRepo.getOrThrow(podId);
          if (pod.status === 'running') {
            const escalationPayload = event.payload.payload;
            const escalationSummary =
              'question' in escalationPayload
                ? escalationPayload.question
                : 'description' in escalationPayload
                  ? escalationPayload.description
                  : 'Agent requested input';
            emitActivityStatus(
              podId,
              `Waiting for human input [${event.escalationType}]: ${escalationSummary}`,
            );
            transition(pod, 'awaiting_input', {
              pendingEscalation: event.payload,
              escalationCount: pod.escalationCount + 1,
            });
          }
        } else if (event.type === 'plan') {
          podRepo.update(podId, {
            plan: { summary: event.summary, steps: event.steps },
          });
        } else if (event.type === 'progress') {
          podRepo.update(podId, {
            progress: {
              phase: event.phase,
              description: event.description,
              currentPhase: event.currentPhase,
              totalPhases: event.totalPhases,
            },
          });
          progressEventRepo?.insert(
            podId,
            event.phase,
            event.description,
            event.currentPhase,
            event.totalPhases,
          );
        } else if (event.type === 'task_summary') {
          podRepo.update(podId, {
            taskSummary: {
              actualSummary: event.actualSummary,
              how: event.how,
              deviations: event.deviations,
              factEvidence: event.factEvidence,
              memoryOutcomes: event.memoryOutcomes,
            },
          });
        } else if (event.type === 'status' && event.sessionId) {
          // Persist session ID to DB for pause/resume survival across daemon restarts
          const sessionPod = podRepo.getOrThrow(podId);
          const activeAttemptBeforeSessionUpdate = deps.providerAttemptRepo?.getActive(podId);
          if (
            activeAttemptBeforeSessionUpdate?.nativeSessionId &&
            activeAttemptBeforeSessionUpdate.nativeSessionId !== event.sessionId
          ) {
            // Provider-attempt identity is append-and-close only. A recovered
            // runtime can accept the requested resume yet report a replacement
            // native session. Close the old segment before recording the new ID
            // instead of attempting to rewrite historical execution identity.
            rotateProviderAttemptForFreshSegment(sessionPod, attemptProfile, true, runToken);
          }
          const sessionUpdate: PodUpdates = {};
          if (sessionPod.runtime === 'claude') sessionUpdate.claudeSessionId = event.sessionId;
          else if (sessionPod.runtime === 'codex') sessionUpdate.codexSessionId = event.sessionId;
          else if (sessionPod.runtime === 'pi') sessionUpdate.piSessionId = event.sessionId;
          if (Object.keys(sessionUpdate).length > 0) podRepo.update(podId, sessionUpdate);
          const activeAttempt = deps.providerAttemptRepo?.getActive(podId);
          if (activeAttempt) {
            deps.providerAttemptRepo?.updateActive(podId, {
              expectedOrdinal: runOwner.providerOrdinal,
              nativeSessionId: event.sessionId,
              inputTokens: activeAttempt.inputTokens,
              outputTokens: activeAttempt.outputTokens,
              costUsd: activeAttempt.costUsd,
            });
          }
        } else if (event.type === 'complete') {
          outcome = 'completed';
          observedTerminalOutcome = 'completed';
          podRepo.completionJournal?.settle(podRepo.getOrThrow(podId), event.result);
          // Accumulate token counts and cost cumulatively across all runs in this pod
          const currentSession = podRepo.getOrThrow(podId);
          const newInputTokens = currentSession.inputTokens + (event.totalInputTokens ?? 0);
          const newOutputTokens = currentSession.outputTokens + (event.totalOutputTokens ?? 0);
          const tokenUpdates: PodUpdates = {};
          if (event.totalInputTokens !== undefined || event.totalOutputTokens !== undefined) {
            tokenUpdates.inputTokens = newInputTokens;
            tokenUpdates.outputTokens = newOutputTokens;
            const bucketKey = agentPhaseBucketKey(attempt);
            const existing = currentSession.phaseTokenUsage ?? {};
            const prev = existing[bucketKey] ?? { inputTokens: 0, outputTokens: 0 };
            const phaseCostUsd = (prev.costUsd ?? 0) + (event.costUsd ?? 0);
            const phaseCachedInputTokens =
              (prev.cachedInputTokens ?? 0) + (event.cachedInputTokens ?? 0);
            const phaseCacheCreationInputTokens =
              (prev.cacheCreationInputTokens ?? 0) + (event.cacheCreationInputTokens ?? 0);
            tokenUpdates.phaseTokenUsage = {
              ...existing,
              [bucketKey]: {
                inputTokens: prev.inputTokens + (event.totalInputTokens ?? 0),
                outputTokens: prev.outputTokens + (event.totalOutputTokens ?? 0),
                ...(phaseCachedInputTokens > 0 && {
                  cachedInputTokens: phaseCachedInputTokens,
                }),
                ...(phaseCacheCreationInputTokens > 0 && {
                  cacheCreationInputTokens: phaseCacheCreationInputTokens,
                }),
                ...(phaseCostUsd > 0 && { costUsd: phaseCostUsd }),
              },
            };
          }
          if (event.costUsd !== undefined) {
            tokenUpdates.costUsd = currentSession.costUsd + event.costUsd;
          }
          if (
            event.totalInputTokens !== undefined ||
            event.totalOutputTokens !== undefined ||
            event.costUsd !== undefined
          ) {
            const hasPriorTelemetry =
              currentSession.inputTokens > 0 ||
              currentSession.outputTokens > 0 ||
              currentSession.costUsd > 0;
            tokenUpdates.tokenTelemetryAccuracy =
              currentSession.tokenTelemetryAccuracy === 'repaired'
                ? 'repaired'
                : currentSession.tokenTelemetryAccuracy === 'partial' && hasPriorTelemetry
                  ? 'partial'
                  : 'complete';
          }
          if (Object.keys(tokenUpdates).length > 0) {
            podRepo.update(podId, tokenUpdates);
          }
          const activeAttempt = deps.providerAttemptRepo?.getActive(podId);
          if (activeAttempt) {
            deps.providerAttemptRepo?.updateActive(podId, {
              expectedOrdinal: runOwner.providerOrdinal,
              nativeSessionId: nativeSessionId(podRepo.getOrThrow(podId)),
              inputTokens: activeAttempt.inputTokens + (event.totalInputTokens ?? 0),
              outputTokens: activeAttempt.outputTokens + (event.totalOutputTokens ?? 0),
              costUsd: activeAttempt.costUsd + (event.costUsd ?? 0),
            });
          }

          const blockerSummary = summarizeAgentCompletionBlocker(event.result);
          if (blockerSummary) {
            const s = podRepo.getOrThrow(podId);
            if (s.status === 'running') {
              emitActivityStatus(podId, `Agent reported blocker: ${blockerSummary}`);
              transition(s, 'failed', {
                completedAt: new Date().toISOString(),
                lastCorrectionMessage: blockerSummary,
              });
            }
            outcome = 'failed';
            observedTerminalOutcome = 'failed';
            break;
          }

          // Token budget enforcement — only when token data is available
          const taskUsage = podRepo.taskExecutions?.snapshot(podId);
          const effectiveBudget = taskUsage ? taskUsage.tokenBudget : currentSession.tokenBudget;
          const totalUsed = taskUsage
            ? (taskUsage.recordedTotalTokens ??
              taskUsage.recordedInputTokens + taskUsage.recordedOutputTokens)
            : newInputTokens + newOutputTokens;
          const nativeAchievement =
            lifecycle?.nativeGoal &&
            deps.launchConfiguration?.goals?.get(podId)?.state === 'achieved';
          if (
            !nativeAchievement &&
            effectiveBudget !== null &&
            effectiveBudget > 0 &&
            totalUsed > 0
          ) {
            const profile = executionForPod(currentSession);
            const warnAt = profile.tokenBudgetWarnAt ?? 0.8;

            if (totalUsed >= Math.floor(effectiveBudget * warnAt) && totalUsed < effectiveBudget) {
              eventBus.emit({
                type: 'pod.token_budget_warning',
                timestamp: new Date().toISOString(),
                podId,
                tokensUsed: totalUsed,
                tokenBudget: effectiveBudget,
                percentUsed: totalUsed / effectiveBudget,
              });
            }

            if (totalUsed >= effectiveBudget) {
              const maxExtensions = profile.maxBudgetExtensions;
              const extensionsUsed = currentSession.budgetExtensionsUsed;
              const canExtend = maxExtensions === null || extensionsUsed < maxExtensions;
              const policy = profile.tokenBudgetPolicy ?? 'soft';

              emitActivityStatus(
                podId,
                `Token budget exceeded (${totalUsed}/${effectiveBudget} tokens used).${canExtend && policy === 'soft' ? ' Waiting for user approval to continue.' : ' Pod will be stopped.'}`,
              );
              eventBus.emit({
                type: 'pod.token_budget_exceeded',
                timestamp: new Date().toISOString(),
                podId,
                tokensUsed: totalUsed,
                tokenBudget: effectiveBudget,
                budgetExtensionsUsed: extensionsUsed,
                maxBudgetExtensions: maxExtensions,
              });

              if (policy === 'hard' || !canExtend) {
                emitActivityStatus(podId, 'Token budget hard limit reached — failing pod');
                const s = podRepo.getOrThrow(podId);
                if (s.status === 'running') {
                  transition(s, 'failed', {
                    completedAt: new Date().toISOString(),
                    failureReason: `Token budget exceeded (${totalUsed}/${effectiveBudget} tokens used).`,
                  });
                }
                outcome = 'failed';
                observedTerminalOutcome = 'failed';
              } else {
                // Soft policy: pause and await user approval
                const s = podRepo.getOrThrow(podId);
                if (s.status === 'running') {
                  transition(s, 'paused', { pauseReason: 'budget' });
                  logger.info(
                    { podId, totalUsed, effectiveBudget },
                    'Pod paused: token budget exceeded',
                  );
                }
                outcome = 'paused';
              }
              break;
            }
          } else if (effectiveBudget !== null && effectiveBudget > 0 && totalUsed === 0) {
            logger.warn(
              { podId, runtime: currentSession.runtime },
              'Token budget set but runtime emits no token data — budget not enforced',
            );
          }
        } else if (
          event.type === 'error' &&
          (event.fatal || event.executionTermination === 'unverified')
        ) {
          if (event.executionTermination === 'unverified') retainUnverifiedTermination();
          const pod = podRepo.getOrThrow(podId);
          terminalClassification =
            event.classification ??
            ({
              category: 'unknown',
              definitive: false,
              sanitizedMessage: sanitizeFailureReason(event.message, 'Agent failed'),
              retryAfter: null,
            } satisfies ProviderFailureClassification);
          if (
            terminalClassification.category === 'transient' ||
            terminalClassification.category === 'provider_unavailable'
          )
            providerRetryNotBefore = workerRetryDeadline(
              terminalClassification.retryAfter,
              Date.now(),
            );
          if (canFail(pod.status)) {
            const failureReason = sanitizeFailureReason(event.message, 'Agent failed');
            emitActivityStatus(podId, failureReason);
            if (
              terminalClassification.category === 'quota_exhausted' &&
              terminalClassification.definitive
            ) {
              transition(pod, 'paused', {
                pauseReason: 'provider_limit',
                failureReason,
              });
            } else {
              transition(pod, 'failed', {
                completedAt: new Date().toISOString(),
                failureReason,
              });
            }
          }
          outcome = 'failed';
          observedTerminalOutcome = 'failed';
          break;
        } else if (event.type === 'tool_use' || event.type === 'file_change') {
          touchHeartbeat(podId);
        }
      }
    } catch (err) {
      if (err instanceof AutopodError && err.code === 'EXEC_EXIT_UNVERIFIED')
        retainUnverifiedTermination();
      if (!ownsRun()) {
        outcome = 'stopped';
        return outcome;
      }
      outcome = 'failed';
      observedTerminalOutcome = 'failed';
      terminalClassification = {
        // Preserve the typed pre-agent sandbox recovery path. Other thrown
        // failures do not acquire an automatic worker retry allowance.
        category:
          err instanceof SandboxInfrastructureError &&
          !workerEventObserved &&
          !hasDurableAgentExecutionEvidence(attemptPod)
            ? 'transient'
            : 'unknown',
        definitive: false,
        sanitizedMessage: sanitizeFailureReason(
          err instanceof Error ? err.message : String(err),
          'Agent failed',
        ),
        retryAfter: null,
      };
      providerRetryNotBefore = null;
      eventError = err;
      hasEventError = true;
    } finally {
      if (!ownsRun()) {
        superseded = true;
        // No terminal event was accepted for this run after it lost ownership.
        outcome = 'stopped';
      } else if (pauseIntents.has(podId)) outcome = 'paused';
      // An accepted old completion is historical evidence even when control
      // must stop before touching a replacement lifecycle.
      const recordedOutcome = superseded ? (observedTerminalOutcome ?? outcome) : outcome;
      try {
        if (!superseded && !executionTerminationUnverified)
          await syncSandboxRuntimeSessionState(attemptPod, ownsRun);
      } finally {
        try {
          if (!ownsRun()) superseded = true;
          if (!superseded) {
            const current = podRepo.getOrThrow(podId);
            const providerLimit =
              current.pauseReason === 'provider_limit' &&
              terminalClassification?.category === 'quota_exhausted' &&
              terminalClassification.definitive;
            if (providerLimit) {
              closeProviderAttempt(
                podId,
                'quota_exhausted',
                terminalClassification,
                PROVIDER_FAILOVER_HANDOFF_PATH,
                runOwner.providerOrdinal,
              );
              await handleProviderLimit(podId, terminalClassification);
            } else if (
              current.pauseReason === 'provider_limit' &&
              outcome === 'failed' &&
              terminalClassification
            ) {
              closeProviderAttempt(
                podId,
                'failed',
                terminalClassification,
                null,
                runOwner.providerOrdinal,
              );
            } else if (outcome === 'paused' || current.status === 'paused') {
              closeProviderAttempt(podId, 'aborted', null, null, runOwner.providerOrdinal);
            } else if (outcome === 'completed' || outcome === 'failed') {
              const classification =
                outcome === 'failed'
                  ? (terminalClassification ?? {
                      category: 'unknown',
                      definitive: false,
                      sanitizedMessage: 'Provider attempt ended without classified evidence',
                      retryAfter: null,
                    })
                  : null;
              closeProviderAttempt(podId, outcome, classification, null, runOwner.providerOrdinal);
            }
          }
        } catch (err) {
          if (err instanceof ProviderAttemptSupersededError) superseded = true;
          else {
            eventError = err;
            hasEventError = true;
          }
        } finally {
          try {
            if (taskRunId) {
              if (executionTerminationUnverified)
                podRepo.taskExecutions?.retainUnverifiedRun(taskRunId);
              else
                podRepo.taskExecutions?.finishRun(
                  taskRunId,
                  recordedOutcome,
                  terminalClassification?.category ?? null,
                );
            }
            if (workerAdmissionId)
              podRepo.workerRetries?.finish(
                workerAdmissionId,
                executionTerminationUnverified
                  ? 'unknown'
                  : recordedOutcome === 'completed'
                    ? 'pass'
                    : recordedOutcome === 'paused' || recordedOutcome === 'stopped'
                      ? 'cancelled'
                      : terminalClassification?.category === 'auth'
                        ? 'nonretryable'
                        : terminalClassification?.category === 'transient' ||
                            terminalClassification?.category === 'provider_unavailable'
                          ? 'transient'
                          : 'unknown',
                workerStartedAt === undefined || executionTerminationUnverified
                  ? null
                  : Math.max(0, Math.round(performance.now() - workerStartedAt)),
                executionTerminationUnverified || recordedOutcome !== 'failed'
                  ? null
                  : providerRetryNotBefore,
              );
          } finally {
            if (activeAgentRuns.get(podId)?.token === runToken) {
              stopCommitPolling(podId);
              lastEventWriteAt.delete(podId);
            }
            settleActiveRun();
          }
        }
      }
    }
    if (superseded) return 'stopped';
    if (hasEventError) throw eventError;
    return outcome;
  }
  return { consumeAgentEvents };
}
