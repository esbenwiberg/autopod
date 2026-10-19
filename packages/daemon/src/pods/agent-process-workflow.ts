import { rm } from 'node:fs/promises';
import type { AgentEvent, EscalationRequest } from '@autopod/shared';
import { AutopodError, PROVIDER_FAILOVER_HANDOFF_PATH, generateId } from '@autopod/shared';
import { SandboxInfrastructureError } from '../containers/sandbox-api-client.js';
import { type ClaudeRuntime, ResumeSessionNotFoundError } from '../runtimes/claude-runtime.js';
import type { CodexRuntime } from '../runtimes/codex-runtime.js';
import {
  GitCredentialError,
  GitMissingRemoteBranchError,
  GitTransientFetchError,
} from '../worktrees/local-worktree-manager.js';
import type { OperatorFailurePhase } from './agent-execution-contracts.js';
import type {
  AgentExecutionLiveDependencies,
  AgentProcessCalls,
  AgentProcessCaptured,
} from './agent-execution-contracts.js';
import {
  deriveAgentAttempt,
  hasLatestPersistedAgentTerminalEventComplete,
} from './agent-execution-policy.js';
import { REWORK_IN_PROGRESS_PREFIX } from './continuation-policy.js';
import { AgentContinuationSupersededError } from './continuation-preflight.js';
import { persistEscalation } from './escalation-coordinator.js';
import { inspectExecutionPreflight } from './execution-preflight.js';
import { ProviderAttemptSupersededError } from './provider-attempt-repository.js';
import { canFail, canKill, isTerminalState } from './state-machine.js';

export function createAgentProcessWorkflow(
  deps: Pick<
    AgentExecutionLiveDependencies,
    'launchConfiguration' | 'eventRepo' | 'providerAttemptRepo'
  >,
  captured: AgentProcessCaptured,
) {
  const {
    podRepo,
    logger,
    emitActivityStatus,
    resolveEffectiveBoundProfile,
    provisioningWorkflow,
    runtimeRegistry,
    ensureProviderAttempt,
    activeAgentRuns,
    touchHeartbeat,
    rotateProviderAttemptForFreshSegment,
    buildReworkTask,
    buildContinuationPrompt,
    buildRecoveryTask,
    recordContinuationProvenance,
    primeRuntimeForResume,
    appendDecisionContext,
    ownsLifecycle,
    persistRuntimeCredentialsForPod,
    preserveSandboxAfterAgentFailure,
    hasDurableAgentExecutionEvidence,
    tryRecoverTransientSandboxFailure,
    closeProviderAttempt,
    scheduleHostFetchRetry,
    emitActivityError,
    transition,
    escalationRepo,
    operatorErrorMessage,
    containerManagerFactory,
    CONTAINER_CLEANUP_TIMEOUT_MS,
  } = captured;

  async function processPod(this: AgentProcessCalls, podId: string): Promise<void> {
    let pod = podRepo.getOrThrow(podId);
    let launchConfig = deps.launchConfiguration?.read(podId) ?? null;
    const lifecycleGeneration = pod.lifecycleGeneration;
    const startingAttempt = deriveAgentAttempt(pod.phaseTokenUsage);
    let visibleFailurePhase: OperatorFailurePhase = 'setup';
    let runtimeEventObserved = false;
    const stagedReferenceArchivePaths = new Set<string>();
    let startupAdmission: { id: string; started: number | null } | undefined;
    const finishStartup = (outcome: import('@autopod/shared').TaskRetryOutcome): void => {
      if (!startupAdmission) return;
      podRepo.sandboxStartupRetries?.finish(
        startupAdmission.id,
        outcome,
        startupAdmission.started === null || outcome === 'unknown'
          ? null
          : Math.round(performance.now() - startupAdmission.started),
      );
      startupAdmission = undefined;
    };

    // Defense-in-depth: processPod must only run for pods in queued/handoff state.
    // The queue's activeIds dedup prevents most races, but this guard ensures
    // a stale processPod call can never kill a pod that's already running.
    if (pod.status !== 'queued' && pod.status !== 'handoff') {
      logger.warn(
        { podId, status: pod.status },
        'processPod skipped — pod not in queued/handoff state',
      );
      return;
    }

    function emitStatus(message: string): void {
      emitActivityStatus(podId, message);
    }

    const assertStartupCurrent = (): void => {
      const current = podRepo.getOrThrow(podId);
      if (
        current.lifecycleGeneration !== lifecycleGeneration ||
        (current.status !== 'queued' && current.status !== 'handoff')
      )
        throw new AgentContinuationSupersededError();
      resolveEffectiveBoundProfile(current);
    };

    try {
      const provisioning = await provisioningWorkflow.preparePodExecution({
        podId,
        pod,
        launchConfig,
        lifecycleGeneration,
        run: {
          get startupAdmission() {
            return startupAdmission;
          },
          set startupAdmission(value) {
            startupAdmission = value;
          },
          finishStartup,
          emitStatus,
          assertStartupCurrent,
          stagedReferenceArchivePaths,
        },
      });
      if (provisioning.kind === 'halted') return;
      ({ pod, launchConfig } = provisioning.prepared);
      const {
        containerManager,
        containerId,
        profile,
        isFreshContainerValidationOnly,
        isRecovery,
        isInfrastructureRecovery,
        isRework,
        systemInstructions,
        secretEnv,
        worktreePath,
        mcpServers,
        reasoningEffort,
        providerResult,
      } = provisioning.prepared;

      // skipAgent bypasses the runtime spawn. A queued recovery originates
      // from Resume's fresh-container validation-only path and must enter
      // validation directly; a handoff originates from `--skip-agent` and
      // still uses handleCompletion to evaluate and deliver the human work.
      // Clear the one-shot flag *before* handing off so a future failed →
      // resume cycle re-runs the agent normally.
      if (pod.skipAgent) {
        const preservedProvenance = await inspectExecutionPreflight(
          containerManager,
          containerId,
          pod,
          profile,
          'completion',
        );
        podRepo.executionProvenance?.record(podId, pod.lifecycleGeneration, preservedProvenance);
        finishStartup('pass');
        podRepo.update(podId, { skipAgent: false });
        if (isFreshContainerValidationOnly) {
          emitStatus('Skipping agent — running validation only…');
          logger.info({ podId }, 'skipAgent: fresh-container recovery entering validation');
          visibleFailurePhase = 'validation';
          await this.triggerValidation(podId, { validationOnly: true });
          return;
        }
        emitStatus('Skipping agent — going straight to completion…');
        logger.info(
          { podId, output: pod.options.output },
          'skipAgent: bypassing runtime spawn, proceeding to handleCompletion',
        );
        visibleFailurePhase = 'completion';
        await this.handleCompletion(podId);
        return;
      }

      if (
        isRecovery &&
        !isInfrastructureRecovery &&
        !isRework &&
        (launchConfig?.intent === 'goal'
          ? (() => {
              const goal = deps.launchConfiguration?.goals?.get(podId);
              return goal?.state === 'achieved' && goal.executionStopped;
            })()
          : hasLatestPersistedAgentTerminalEventComplete(
              deps.eventRepo,
              podId,
              podRepo.completionJournal?.replyWatermark(podId) ?? 0,
            ))
      ) {
        const recoveredProvenance = await inspectExecutionPreflight(
          containerManager,
          containerId,
          pod,
          profile,
          'completion',
        );
        podRepo.executionProvenance?.record(podId, pod.lifecycleGeneration, recoveredProvenance);
        finishStartup('pass');
        emitStatus('Agent already finished before recovery — resuming completion…');
        logger.info(
          { podId, worktreePath },
          'Recovery found persisted agent complete event — skipping agent spawn',
        );
        visibleFailurePhase = 'completion';
        await this.handleCompletion(podId);
        return;
      }

      // Start the agent — recovery mode uses resume for Claude, fresh spawn for others
      emitStatus(
        `Starting worker: provider=${profile.modelProvider ?? 'anthropic'}, runtime=${pod.runtime}, model=${pod.model}`,
      );
      const provenance = await inspectExecutionPreflight(
        containerManager,
        containerId,
        pod,
        profile,
      );
      const recordedProvenance = podRepo.executionProvenance?.record(
        podId,
        pod.lifecycleGeneration,
        provenance,
      );
      if (provenance.status === 'blocked') {
        const failure = provenance.diagnostics.find(
          (item) =>
            item.code.startsWith('PREFLIGHT_') || item.code === 'STREAMING_EXEC_UNSUPPORTED',
        );
        const message = failure?.detail ?? 'Execution preflight requires reconciliation';
        emitStatus(message);
        throw new AutopodError(message, failure?.code ?? 'EXECUTION_PREFLIGHT_BLOCKED', 409);
      }
      logger.info(
        {
          podId,
          runtime: pod.runtime,
          cliPath: provenance.cliPath,
          cliVersion: provenance.cliVersion,
        },
        'Agent CLI preflight passed',
      );

      emitStatus('Spawning agent…');
      const runtime = runtimeRegistry.get(pod.runtime);
      let events: AsyncIterable<AgentEvent>;
      const activeProviderAttemptBeforeStart = deps.providerAttemptRepo?.getActive(podId);
      const hadActiveProviderAttempt = !!activeProviderAttemptBeforeStart;
      let providerAttemptRotated = false;
      ensureProviderAttempt(pod, profile);

      // Codex and Copilot need the generated Autopod instructions passed through the
      // runtime adapter. Claude reads the same file via --append-system-prompt-file.
      let runtimeInstructions: string | undefined =
        pod.runtime === 'codex' || pod.runtime === 'copilot' ? systemInstructions : undefined;

      // For Copilot, defensively merge the repo's own instructions (if any) with ours.
      // We can't be sure Copilot CLI reads both $COPILOT_HOME/copilot-instructions.md
      // and .github/copilot-instructions.md, so prepend the repo's file to be safe.
      if (pod.runtime === 'copilot') {
        try {
          const repoInstructions = await containerManager.readFile(
            containerId,
            '/workspace/.github/copilot-instructions.md',
          );
          if (repoInstructions.trim()) {
            runtimeInstructions = `${repoInstructions}\n\n---\n\n${systemInstructions}`;
            logger.info(
              { podId },
              'Merged repo copilot-instructions.md with autopod system instructions',
            );
          }
        } catch {
          // No repo-level copilot instructions — use ours as-is
        }
      }

      if (launchConfig?.intent === 'goal') {
        const goals = deps.launchConfiguration?.goals;
        if (!goals || !runtime.nativeGoalSession || !recordedProvenance)
          throw new AutopodError('Native Goal execution is unavailable', 'GOAL_UNAVAILABLE', 503);
        if (isRework)
          throw new AutopodError(
            'An achieved native Goal cannot be replaced by validation rework',
            'GOAL_REWORK_REQUIRES_TASK',
            409,
          );
        const config = launchConfig;
        const nativeSession = runtime.nativeGoalSession(
          {
            podId,
            task: config.task,
            model: pod.model,
            reasoningEffort,
            workDir: '/workspace',
            containerId,
            customInstructions: runtimeInstructions,
            env: secretEnv,
            mcpServers,
            executionTarget: pod.executionTarget,
          },
          goals.processHooks(podId, config),
        );
        events = (async function* () {
          const owner = activeAgentRuns.get(podId);
          if (!owner?.taskRunId)
            throw new AutopodError(
              'Native Goal requires a durable execution attempt',
              'GOAL_ATTEMPT_MISSING',
              409,
            );
          const assertCurrent = () => {
            if (activeAgentRuns.get(podId)?.token !== owner.token || !owner.isCurrent?.())
              throw new AutopodError(
                'Native Goal execution was superseded',
                'GOAL_SUPERSEDED',
                409,
              );
          };
          try {
            const goal = await goals.run({
              pod: podRepo.getOrThrow(podId),
              config,
              provenance: recordedProvenance,
              fence: { generation: lifecycleGeneration, attemptId: owner.taskRunId },
              session: nativeSession,
              assertCurrent,
              onState(goal) {
                if (!owner.isCurrent?.()) return;
                touchHeartbeat(podId);
                emitActivityStatus(
                  podId,
                  `Native Goal ${goal.state}: ${goal.observedTokens} tokens including evaluation`,
                );
              },
            });
            assertCurrent();
            if (goal.state === 'achieved' && goal.executionStopped)
              yield {
                type: 'complete' as const,
                timestamp: goal.updatedAt,
                result: 'Native Goal achieved',
              };
            else
              yield {
                type: 'error' as const,
                timestamp: goal.updatedAt,
                fatal: true,
                message: `Native Goal ${goal.state}; continuation requires operator review`,
              };
          } catch (error) {
            const goal = goals.get(podId);
            yield {
              type: 'error' as const,
              timestamp: new Date().toISOString(),
              fatal: true,
              message:
                error instanceof AutopodError
                  ? error.message
                  : 'Native Goal requires reconciliation',
              ...(!goal?.executionStopped ? { executionTermination: 'unverified' as const } : {}),
            };
          }
        })();
      } else if (isRework) {
        // Rework: always a fresh spawn with rework-specific framing.
        // claudeSessionId was already cleared by triggerValidation so we never
        // resume a stale/broken pod context.
        providerAttemptRotated = rotateProviderAttemptForFreshSegment(
          pod,
          profile,
          hadActiveProviderAttempt,
        );
        emitStatus('Reworking pod…');
        // biome-ignore lint/style/noNonNullAssertion: reworkReason is always set when isRework=true; worktreePath is non-null when isRework=true (rework requires a prior run with a worktree)
        const reworkTask = await buildReworkTask(pod, worktreePath!, pod.reworkReason!);
        events = runtime.spawn({
          podId,
          task: reworkTask,
          model: pod.model,
          reasoningEffort,
          workDir: '/workspace',
          containerId,
          customInstructions: runtimeInstructions,
          env: secretEnv,
          mcpServers,
          executionTarget: pod.executionTarget,
        });

        // Clear rework reason now that it's been consumed (one-shot)
        podRepo.update(podId, {
          reworkReason: null,
          lastCorrectionMessage: `${REWORK_IN_PROGRESS_PREFIX} ${pod.reworkReason}`,
        });
      } else if (
        isRecovery &&
        !isInfrastructureRecovery &&
        pod.runtime === 'claude' &&
        pod.claudeSessionId
      ) {
        // Crash recovery: attempt Claude --resume with persisted pod ID
        if (
          activeProviderAttemptBeforeStart?.nativeSessionId &&
          activeProviderAttemptBeforeStart.nativeSessionId !== pod.claudeSessionId
        ) {
          providerAttemptRotated = rotateProviderAttemptForFreshSegment(
            pod,
            profile,
            hadActiveProviderAttempt,
          );
        }
        emitStatus('Resuming Claude pod…');

        // Rehydrate the in-memory pod ID map so resume() can find it
        if ('setClaudeSessionId' in runtime) {
          (runtime as ClaudeRuntime).setClaudeSessionId(podId, pod.claudeSessionId);
        }
        if ('setClaudeResumeConfig' in runtime) {
          (runtime as ClaudeRuntime).setClaudeResumeConfig(podId, mcpServers, reasoningEffort);
        }

        // biome-ignore lint/style/noNonNullAssertion: worktreePath is non-null for recovery pods (recovery requires a prior run with a worktree)
        const continuationPrompt = await buildContinuationPrompt(pod, worktreePath!);
        // biome-ignore lint/style/noNonNullAssertion: worktreePath is non-null for recovery pods
        const safeWorktreePath = worktreePath!;

        // The resume call returns the iterator synchronously — the failure
        // (Claude printing "No conversation found with session ID" and exiting)
        // surfaces mid-iteration as a thrown ResumeSessionNotFoundError. Wrap
        // in a generator so we can catch the throw, clear the stale session
        // ID, and fall through to a fresh spawn in the same container without
        // dying silently. (The container is still alive after Claude's exit.)
        const podRepoRef = podRepo;
        const runtimeRef = runtime;
        const containerIdRef = containerId;
        const podModel = pod.model;
        const podRef = pod;
        const mcpServersRef = mcpServers;
        const customInstructionsRef = runtimeInstructions;
        const secretEnvRef = secretEnv;
        const loggerRef = logger;
        const profileRef = profile;
        events = (async function* resumeWithFallback() {
          const fallbackRunToken = activeAgentRuns.get(podId)?.token;
          try {
            yield* runtimeRef.resume(podId, continuationPrompt, containerIdRef, secretEnvRef);
          } catch (err) {
            if (!(err instanceof ResumeSessionNotFoundError)) throw err;
            loggerRef.warn(
              { podId, claudeSessionId: err.claudeSessionId },
              'Claude --resume found no conversation on disk — falling back to fresh spawn',
            );
            // Clear the stale ID so any future recovery on this pod doesn't
            // loop trying to resume the same nonexistent conversation.
            if (
              !fallbackRunToken ||
              activeAgentRuns.get(podId)?.token !== fallbackRunToken ||
              !activeAgentRuns.get(podId)?.isCurrent?.()
            )
              throw new ProviderAttemptSupersededError();
            if (!providerAttemptRotated) {
              rotateProviderAttemptForFreshSegment(
                podRef,
                profileRef,
                hadActiveProviderAttempt,
                fallbackRunToken,
              );
            }
            podRepoRef.update(podId, { claudeSessionId: null });
            const recoveryTask = await buildRecoveryTask(podRef, safeWorktreePath);
            await recordContinuationProvenance(podRef, containerIdRef);
            if (
              activeAgentRuns.get(podId)?.token !== fallbackRunToken ||
              !activeAgentRuns.get(podId)?.isCurrent?.()
            )
              throw new ProviderAttemptSupersededError();
            yield* runtimeRef.spawn({
              podId,
              task: recoveryTask,
              model: podModel,
              reasoningEffort,
              workDir: '/workspace',
              containerId: containerIdRef,
              customInstructions: customInstructionsRef,
              env: secretEnvRef,
              mcpServers: mcpServersRef,
              executionTarget: podRef.executionTarget,
            });
          }
        })();
      } else if (
        isRecovery &&
        !isInfrastructureRecovery &&
        pod.runtime === 'codex' &&
        pod.codexSessionId
      ) {
        // Codex crash recovery: continue the existing session
        if (
          activeProviderAttemptBeforeStart?.nativeSessionId &&
          activeProviderAttemptBeforeStart.nativeSessionId !== pod.codexSessionId
        ) {
          rotateProviderAttemptForFreshSegment(pod, profile, hadActiveProviderAttempt);
        }
        emitStatus('Resuming Codex pod…');
        if ('setCodexResumeConfig' in runtime) {
          (runtime as CodexRuntime).setCodexResumeConfig(podId, mcpServers, reasoningEffort);
        }
        // biome-ignore lint/style/noNonNullAssertion: worktreePath is non-null for recovery pods
        const codexContinuationPrompt = await buildContinuationPrompt(pod, worktreePath!);
        events = runtime.resume(podId, codexContinuationPrompt, containerId, secretEnv);
      } else if (
        isRecovery &&
        !isInfrastructureRecovery &&
        pod.runtime === 'pi' &&
        pod.piSessionId
      ) {
        if (
          activeProviderAttemptBeforeStart?.nativeSessionId &&
          activeProviderAttemptBeforeStart.nativeSessionId !== pod.piSessionId
        ) {
          rotateProviderAttemptForFreshSegment(pod, profile, hadActiveProviderAttempt);
        }
        emitStatus('Resuming Pi pod…');
        await primeRuntimeForResume(pod, runtime, containerId, secretEnv);
        // biome-ignore lint/style/noNonNullAssertion: recovery pods have a worktree
        const piContinuationPrompt = await buildContinuationPrompt(pod, worktreePath!);
        events = runtime.resume(podId, piContinuationPrompt, containerId, secretEnv);
      } else if (isRecovery && !isInfrastructureRecovery) {
        // Non-Claude/Codex runtime or no session ID — fresh spawn with recovery context
        rotateProviderAttemptForFreshSegment(pod, profile, hadActiveProviderAttempt);
        // biome-ignore lint/style/noNonNullAssertion: worktreePath is non-null for recovery pods
        let recoveryTask = await buildRecoveryTask(pod, worktreePath!);
        // For non-Claude runtimes recovering after host wake, append a postscript so the
        // agent checks git history before redoing work already on disk.
        if (pod.runtime !== 'claude' && pod.lastRecoveryTrigger === 'wake') {
          recoveryTask +=
            '\n\nNote: this run was interrupted by a host sleep and restarted. Some' +
            ' work may already be on disk — check `git log` and `git diff main`' +
            ' before continuing.';
        }
        events = runtime.spawn({
          podId,
          task: recoveryTask,
          model: pod.model,
          reasoningEffort,
          workDir: '/workspace',
          containerId,
          customInstructions: runtimeInstructions,
          env: secretEnv,
          mcpServers,
          executionTarget: pod.executionTarget,
        });
      } else {
        // Normal path
        events = runtime.spawn({
          podId,
          task: appendDecisionContext(pod, pod.task),
          model: pod.model,
          reasoningEffort,
          workDir: '/workspace',
          containerId,
          customInstructions: runtimeInstructions,
          env: secretEnv,
          mcpServers,
          executionTarget: pod.executionTarget,
        });
      }

      visibleFailurePhase = 'agent';
      const observedEvents = (async function* () {
        for await (const event of events) {
          if (!runtimeEventObserved) {
            finishStartup('pass');
            podRepo.update(podId, { infrastructureFailure: null });
          }
          runtimeEventObserved = true;
          yield event;
        }
      })();
      const outcome = await this.consumeAgentEvents(podId, observedEvents, startingAttempt, {
        generation: lifecycleGeneration,
        containerId,
        nativeGoal: launchConfig?.intent === 'goal',
      });

      if (!ownsLifecycle(podId, lifecycleGeneration, containerId)) {
        logger.info(
          { podId, containerId, generation: lifecycleGeneration },
          'Discarded stale agent continuation',
        );
        return;
      }

      // Persist any runtime credentials if provider requires it (MAX token rotation, Codex auth.json)
      if (providerResult.requiresPostExecPersistence) {
        await persistRuntimeCredentialsForPod(
          podId,
          'Failed to persist refreshed credentials — pod still succeeded',
        );
      }

      if (outcome === 'completed') {
        visibleFailurePhase = 'completion';
        await this.handleCompletion(podId);
      } else if (outcome === 'failed') {
        await preserveSandboxAfterAgentFailure(podId, 'fatal agent exit');
      }
    } catch (err) {
      if (err instanceof AgentContinuationSupersededError) return;
      if (startupAdmission) {
        const current = podRepo.getOrThrow(podId);
        const safeTransient =
          err instanceof SandboxInfrastructureError &&
          !runtimeEventObserved &&
          (current.skipAgent || !hasDurableAgentExecutionEvidence(current));
        finishStartup(
          startupAdmission.started === null
            ? 'cancelled'
            : safeTransient
              ? 'transient'
              : 'nonretryable',
        );
      }
      if (!ownsLifecycle(podId, lifecycleGeneration, null)) {
        logger.info({ podId, generation: lifecycleGeneration }, 'Discarded stale lifecycle error');
        return;
      }
      if (err instanceof SandboxInfrastructureError) {
        const recovered = await tryRecoverTransientSandboxFailure(
          podId,
          podRepo.getOrThrow(podId),
          runtimeEventObserved,
          err,
          visibleFailurePhase,
        );
        if (recovered) return;
        if (!runtimeEventObserved && !hasDurableAgentExecutionEvidence(podRepo.getOrThrow(podId))) {
          closeProviderAttempt(podId, 'aborted');
        }
      }
      if (err instanceof GitTransientFetchError) {
        const current = podRepo.getOrThrow(podId);
        if (current.status === 'queued') scheduleHostFetchRetry(current, err);
        return;
      }
      if (err instanceof GitMissingRemoteBranchError) {
        const current = podRepo.getOrThrow(podId);
        const message = `Required remote ${err.purpose} branch "${err.branch}" is missing.`;
        emitActivityError(podId, message, true);
        if (current.status === 'queued') transition(current, 'failed', { failureReason: message });
        return;
      }
      if (err instanceof GitCredentialError && (err.op === 'fetch' || err.op === 'clone')) {
        const current = podRepo.getOrThrow(podId);
        if (current.status === 'queued') {
          const escalation: EscalationRequest = {
            id: generateId(12),
            podId,
            type: 'request_credential',
            timestamp: new Date().toISOString(),
            payload: {
              service: err.service,
              reason:
                err.service === 'github'
                  ? 'The daemon could not fetch the required remote branch. Authenticate the daemon GitHub account with gh auth login, then resume this pod.'
                  : 'The daemon could not fetch the required remote branch. Repair the daemon Azure CLI/managed identity access to this Azure DevOps repository, then resume this pod.',
              source: 'host_fetch',
            },
            response: null,
          };
          persistEscalation(podRepo, escalationRepo, escalation, () => {
            transition(current, 'awaiting_input', {
              pendingEscalation: escalation,
              escalationCount: current.escalationCount + 1,
            });
          });
          emitActivityStatus(
            podId,
            'Remote fetch needs repaired host credentials before provisioning.',
          );
          return;
        }
      }
      logger.error({ err, podId }, 'Pod processing error');
      const failureReason = operatorErrorMessage(err, visibleFailurePhase);
      emitActivityError(podId, failureReason, true);
      // Best-effort: recover runtime credentials before the failure path
      // tears the container down. The happy-path persist at the end of the
      // try block was bypassed, so without this latest auth state can die
      // with the container.
      try {
        await persistRuntimeCredentialsForPod(
          podId,
          'Failed to persist rotated credentials after pod error — proceeding',
        );
      } catch (persistErr) {
        logger.warn(
          { err: persistErr, podId },
          'Failed to persist rotated credentials after pod error — proceeding',
        );
      }
      if (
        visibleFailurePhase === 'agent' &&
        !(err instanceof SandboxInfrastructureError && !runtimeEventObserved)
      ) {
        await preserveSandboxAfterAgentFailure(podId, 'agent processing error');
      }
      const attemptHistory = deps.providerAttemptRepo?.list(podId) ?? [];
      const activeContinuityAttempt = deps.providerAttemptRepo?.getActive(podId);
      const precedingAttempt = activeContinuityAttempt
        ? attemptHistory.find((attempt) => attempt.ordinal === activeContinuityAttempt.ordinal - 1)
        : undefined;
      const followsProviderLimit =
        !!activeContinuityAttempt &&
        precedingAttempt?.handoffReference === PROVIDER_FAILOVER_HANDOFF_PATH;
      if (followsProviderLimit) {
        try {
          closeProviderAttempt(
            podId,
            'failed',
            {
              category: 'unknown',
              definitive: false,
              sanitizedMessage: failureReason,
              retryAfter: null,
            },
            PROVIDER_FAILOVER_HANDOFF_PATH,
          );
          pod = podRepo.getOrThrow(podId);
          if (pod.containerId) {
            const cm = containerManagerFactory.get(pod.executionTarget);
            let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
            try {
              await Promise.race([
                cm.kill(pod.containerId),
                new Promise<never>((_resolve, reject) => {
                  cleanupTimer = setTimeout(
                    () => reject(new Error('Continuation startup cleanup timed out')),
                    CONTAINER_CLEANUP_TIMEOUT_MS,
                  );
                }),
              ]);
              podRepo.update(podId, { containerId: null });
              pod = podRepo.getOrThrow(podId);
            } catch (cleanupErr) {
              logger.warn(
                { err: cleanupErr, podId, containerId: pod.containerId },
                'Continuation startup container cleanup could not be proven',
              );
            } finally {
              if (cleanupTimer) clearTimeout(cleanupTimer);
            }
          }
          if (pod.status === 'queued') {
            pod = transition(pod, 'provisioning');
          }
          if (pod.status === 'provisioning' || pod.status === 'running') {
            transition(pod, 'paused', {
              pauseReason: 'provider_limit',
              failureReason,
            });
          }
          emitActivityStatus(
            podId,
            'Provider target failed to start — source work and continuation history preserved',
          );
          return;
        } catch (continuityErr) {
          logger.warn(
            { err: continuityErr, podId },
            'Failed to park provider continuation startup failure',
          );
        }
      }
      // Transition to failed — keeps series dependents queued so they can run once the parent
      // is recovered/retried. 'killed' is reserved for explicit user termination only.
      try {
        closeProviderAttempt(podId, 'failed');
        pod = podRepo.getOrThrow(podId);
        if (!isTerminalState(pod.status)) {
          if (canFail(pod.status)) {
            transition(pod, 'failed', {
              completedAt: new Date().toISOString(),
              failureReason,
            });
          } else if (canKill(pod.status)) {
            // Fallback for states not yet reachable via 'failed' (validated, review_required, etc.)
            transition(pod, 'killing', { failureReason });
            pod = podRepo.getOrThrow(podId);
            transition(pod, 'killed', { completedAt: new Date().toISOString() });
          }
        }
      } catch {
        /* swallow — best effort */
      }
    } finally {
      finishStartup('unknown');
      await Promise.all(
        [...stagedReferenceArchivePaths].map((archivePath) => rm(archivePath, { force: true })),
      );
    }
  }
  return { processPod };
}
