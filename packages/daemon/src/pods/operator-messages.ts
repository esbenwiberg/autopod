import type {
  OperatorActor,
  RequestCredentialPayload,
  ValidationOverridePayload,
} from '@autopod/shared';
import { AutopodError } from '@autopod/shared';
import { ResumeSessionNotFoundError } from '../runtimes/claude-runtime.js';
import { GitCredentialError } from '../worktrees/local-worktree-manager.js';
import type { AgentRunOutcome } from './agent-execution-contracts.js';
import { legacyRespondedBy, parseValidationOverrideResponse } from './approval-policy.js';
import { AgentContinuationSupersededError } from './continuation-preflight.js';
import { resolvePrBaseBranch } from './delivery-policy.js';
import { persistCompletionReply } from './escalation-coordinator.js';
import type {
  OperatorMessageCalls,
  OperatorMessageLiveDependencies,
  OperatorMessagesCaptured,
} from './operator-contracts.js';
import { buildDetachedMcpFallbackMessage } from './operator-policy.js';
import { resolvedReasoningEffort } from './provider-attempt-policy.js';
import { canReceiveMessage, isTerminalState } from './state-machine.js';
export function createOperatorMessages(
  deps: OperatorMessageLiveDependencies,
  captured: OperatorMessagesCaptured,
) {
  const {
    pauseIntents,
    podRepo,
    activeAgentRuns,
    executionForPod,
    emitActivityStatus,
    transition,
    logger,
    resolveGitCredential,
    escalationRepo,
    enqueueSession,
    worktreeManager,
    prManagerFactory,
    ensurePrBaseBranchOnOrigin,
    getLatestPushFindings,
    completeFixPodAfterPush,
    maybeTriggerDependents,
    stopSandboxPreviewProxy,
    containerManagerFactory,
    parkOnCredentialFailure,
    nudgeRepo,
    beginGoalTaskRework,
    mergeOverrides,
    taskFeedbackEvents,
    persistRuntimeCredentialsForPod,
    getResumeEnv,
    runtimeRegistry,
    recordContinuationProvenance,
    primeRuntimeForResume,
    buildRecoveryTask,
    resolveEffectiveBoundProfile,
  } = captured;
  async function sendMessage(
    this: OperatorMessageCalls,
    podId: string,
    message: string,
    actor: OperatorActor = { type: 'automation', id: 'direct-pod-manager' },
  ): Promise<void> {
    if (pauseIntents.has(podId)) {
      throw new AutopodError(
        `Pod ${podId} pause is still settling; resume is not yet allowed`,
        'PAUSE_SETTLING',
        409,
      );
    }
    const pod = podRepo.getOrThrow(podId);
    if (deps.launchConfiguration?.read(podId)?.intent === 'goal') {
      const goal = deps.launchConfiguration.goals?.get(podId);
      const escalation = pod.pendingEscalation;
      const source =
        escalation?.type === 'request_credential'
          ? (escalation.payload as RequestCredentialPayload).source
          : undefined;
      const attachedNativeReply = Boolean(
        escalation &&
          !['request_credential', 'validation_override'].includes(escalation.type) &&
          activeAgentRuns.has(podId) &&
          !pod.pauseReason,
      );
      const hostRepair =
        (source === 'host_fetch' && !goal?.fence) ||
        (source === 'host_push' && goal?.state === 'achieved' && goal.executionStopped);
      const validationReply =
        escalation?.type === 'validation_override' &&
        goal?.state === 'achieved' &&
        goal.executionStopped;
      if (!attachedNativeReply && !hostRepair && !validationReply)
        throw new AutopodError(
          'Use native Goal controls to resume; ordinary replies cannot start another agent conversation',
          'GOAL_NATIVE_RESUME_REQUIRED',
          409,
        );
    }
    if (!canReceiveMessage(pod.status)) {
      throw new AutopodError(
        `Pod ${podId} is not awaiting input (status: ${pod.status})`,
        'INVALID_STATE',
        409,
      );
    }

    // ── Budget pause approval ──────────────────────────────────────────
    if (pod.pauseReason === 'budget') {
      const profile = executionForPod(pod);
      const maxExtensions = profile.maxBudgetExtensions;
      const newExtensionsUsed = pod.budgetExtensionsUsed + 1;

      if (maxExtensions !== null && newExtensionsUsed > maxExtensions) {
        throw new AutopodError(
          `Pod ${podId} has reached the maximum budget extensions (${maxExtensions})`,
          'BUDGET_EXHAUSTED',
          409,
        );
      }

      emitActivityStatus(
        podId,
        `Budget extension approved (${newExtensionsUsed}). Proceeding to validation…`,
      );
      podRepo.update(podId, {
        budgetExtensionsUsed: newExtensionsUsed,
        pauseReason: null,
      });

      const refreshed = podRepo.getOrThrow(podId);
      transition(refreshed, 'running');

      try {
        await this.handleCompletion(podId);
      } catch (err) {
        logger.error({ err, podId }, 'Failed to handle completion after budget approval');
        const s = podRepo.getOrThrow(podId);
        if (!isTerminalState(s.status)) {
          transition(s, 'failed');
        }
        throw err;
      }
      return;
    }

    // ── Credential injection ──────────────────────────────────────────
    if (pod.pendingEscalation?.type === 'request_credential') {
      const payload = pod.pendingEscalation.payload as RequestCredentialPayload;

      // Pre-provision host fetch failure: re-resolve the daemon-side credential
      // and queue the same pod. The next queue pass begins with a fresh remote
      // fetch; no container credential injection or agent resume is involved.
      if (payload.source === 'host_fetch') {
        const profile = executionForPod(pod);
        const credential = await resolveGitCredential(profile);
        if (!credential) {
          throw new AutopodError(
            payload.service === 'github'
              ? 'Daemon GitHub authentication is still unavailable. Run gh auth login as the daemon service account and try again.'
              : 'Daemon Azure DevOps authentication is still unavailable. Repair the daemon Azure CLI/managed identity and try again.',
            'MISSING_CREDENTIAL',
            400,
          );
        }
        escalationRepo.update(pod.pendingEscalation.id, {
          respondedAt: new Date().toISOString(),
          respondedBy: legacyRespondedBy(actor),
          actor,
          response: 'credential_repaired',
        });
        transition(pod, 'queued', { pendingEscalation: null });
        emitActivityStatus(
          podId,
          'Host credentials updated — fetching required remote refs again…',
        );
        enqueueSession(podId);
        return;
      }

      // Daemon-side push failure: skip container injection (no agent waiting)
      // and retry the post-validation push from the host with the repaired
      // daemon identity.
      if (payload.source === 'host_push') {
        const profile = executionForPod(pod);
        const pat = await resolveGitCredential(profile);
        if (!pat) {
          throw new AutopodError(
            payload.service === 'github'
              ? 'Daemon GitHub authentication is still unavailable. Run gh auth login as the daemon service account and try again.'
              : 'Daemon Azure DevOps authentication is still unavailable. Repair the daemon Azure CLI/managed identity and try again.',
            'MISSING_CREDENTIAL',
            400,
          );
        }

        if (!pod.worktreePath) {
          throw new AutopodError(
            `Pod ${podId} has no worktree — cannot retry push`,
            'INVALID_STATE',
            409,
          );
        }

        escalationRepo.update(pod.pendingEscalation.id, {
          respondedAt: new Date().toISOString(),
          respondedBy: legacyRespondedBy(actor),
          actor,
          response: 'daemon_auth_repaired',
        });
        // awaiting_input → validating: park-then-retry without re-running the
        // agent. The validation result we already passed is still authoritative.
        const validatingPod = transition(pod, 'validating', { pendingEscalation: null });
        const carryForwardPrUrl = validatingPod.prUrl;
        emitActivityStatus(
          podId,
          carryForwardPrUrl
            ? `${payload.service} PAT updated — retrying push to existing PR…`
            : `${payload.service} PAT updated — retrying branch push and PR creation…`,
        );

        try {
          // Always push first — same shape as the original post-validation
          // path. maxDeletions=0 mirrors `pushAndCreatePr`: the container is
          // already stopped/gone so a phantom mass-delete must not slip in.
          await worktreeManager.mergeBranch({
            worktreePath: validatingPod.worktreePath ?? '',
            targetBranch: validatingPod.branch,
            pat,
            maxDeletions: 0,
            podTask: validatingPod.task,
            profile,
            podModel: validatingPod.model,
          });

          // Only open a new PR if this isn't a fix pod carrying one forward.
          let newPrUrl = carryForwardPrUrl;
          if (!newPrUrl) {
            const prManager = prManagerFactory ? prManagerFactory(profile) : null;
            if (prManager) {
              emitActivityStatus(podId, 'Creating PR…');
              const refreshed = podRepo.getOrThrow(podId);
              const baseBranch = resolvePrBaseBranch(refreshed, profile);
              await ensurePrBaseBranchOnOrigin(refreshed, profile, baseBranch, 'host_push_retry');
              const createResult = await prManager.createPr({
                // biome-ignore lint/style/noNonNullAssertion: validated above
                worktreePath: refreshed.worktreePath!,
                repoUrl: profile.repoUrl ?? undefined,
                branch: refreshed.branch,
                baseBranch,
                podId,
                task: refreshed.task,
                profileName: refreshed.profileName,
                profile,
                podModel: refreshed.model,
                handoffInstructions: refreshed.handoffInstructions ?? undefined,
                validationResult: refreshed.lastValidationResult ?? null,
                validationWaiver: refreshed.validationWaiver,
                filesChanged: refreshed.filesChanged,
                linesAdded: refreshed.linesAdded,
                linesRemoved: refreshed.linesRemoved,
                previewUrl: refreshed.previewUrl,
                screenshots: [],
                taskSummary: refreshed.taskSummary ?? undefined,
                seriesDescription: refreshed.seriesDescription ?? undefined,
                seriesName: refreshed.seriesName ?? undefined,
                securityFindings: getLatestPushFindings(podId),
              });
              newPrUrl = createResult.url ?? null;
              if (newPrUrl) {
                emitActivityStatus(podId, `PR created: ${newPrUrl}`);
              }
            }
          } else {
            emitActivityStatus(podId, `Carrying forward existing PR: ${carryForwardPrUrl}`);
          }

          const validatedPod = transition(podRepo.getOrThrow(podId), 'validated', {
            prUrl: newPrUrl,
            lastCorrectionMessage: null,
          });

          if (validatedPod.linkedPodId) {
            await completeFixPodAfterPush(validatedPod);
            return;
          }

          maybeTriggerDependents(validatedPod);

          // Stop the container post-validation (mirrors the original push path).
          if (validatedPod.containerId) {
            try {
              emitActivityStatus(podId, 'Stopping post-validation container…');
              await stopSandboxPreviewProxy(podId);
              const cm = containerManagerFactory.get(validatedPod.executionTarget);
              await cm.stop(validatedPod.containerId);
            } catch (stopErr) {
              logger.warn(
                { err: stopErr, podId },
                'Failed to stop container after host_push retry',
              );
            }
          }

          if (validatedPod.autoApprove) {
            emitActivityStatus(podId, 'Auto-approving…');
            logger.info({ podId }, 'Auto-approving pod after host_push retry');
            setImmediate(() => {
              this.approveSession(podId, { automation: true }).catch((err) =>
                logger.warn({ err, podId }, 'Auto-approve after host_push retry failed'),
              );
            });
          }
        } catch (err) {
          // Fresh PAT is still bad — re-park rather than fail terminally.
          if (err instanceof GitCredentialError) {
            parkOnCredentialFailure(podId, err);
            return;
          }
          logger.error({ err, podId }, 'host_push retry failed after credential fix');
          const s = podRepo.getOrThrow(podId);
          if (!isTerminalState(s.status)) {
            transition(s, 'failed');
          }
          throw err;
        }
        return;
      }

      const authMessage =
        'Source credentials stay with the AutoPod daemon. Use scoped GitHub tools for reads and allowed actions; the daemon handles push and PR delivery.';

      const escalationId = pod.pendingEscalation.id;
      const pending = deps.pendingRequestsByPod?.get(podId);
      const savedResult = pending?.isDetached(escalationId)
        ? buildDetachedMcpFallbackMessage(pod.pendingEscalation.type, authMessage)
        : authMessage;
      persistCompletionReply(podRepo, pod, message, actor, () => {
        transition(pod, 'running', { pendingEscalation: null });
        nudgeRepo.queue(podId, savedResult);
      });
      emitActivityStatus(
        podId,
        `Direct ${payload.service} credential request declined; daemon delivery guidance saved.`,
      );
      pending?.resolveWithState(escalationId, authMessage);
      return;
    }

    // ── Validation override responses ─────────────────────────────────
    if (pod.pendingEscalation?.type === 'validation_override') {
      const payload = pod.pendingEscalation.payload as ValidationOverridePayload;
      const overrides = parseValidationOverrideResponse(message, payload.findings);
      const goalRework = overrides.some((item) => item.action === 'guidance')
        ? await beginGoalTaskRework(pod, `Apply reviewed validation guidance: ${message}`)
        : false;

      // Resolve the escalation in the DB
      escalationRepo.update(pod.pendingEscalation.id, {
        respondedAt: new Date().toISOString(),
        respondedBy: legacyRespondedBy(actor),
        actor,
        response: message,
      });

      // Merge new overrides into existing pod overrides
      const existingOverrides = pod.validationOverrides ?? [];
      const mergedOverrides = mergeOverrides(existingOverrides, overrides);
      podRepo.update(podId, {
        validationOverrides: mergedOverrides,
        pendingEscalation: null,
      });

      const hasGuidance = overrides.some((o) => o.action === 'guidance');

      if (!hasGuidance) {
        // All dismissed — re-run validation with overrides (doesn't burn an attempt)
        emitActivityStatus(podId, 'Overrides stored — re-running validation…');
        transition(pod, 'running');
        await this.triggerValidation(podId);
      } else {
        // Guidance provided — resume agent with human's instructions
        const guidanceText = overrides
          .filter((o) => o.action === 'guidance' && o.guidance)
          .map((o) => `- ${o.description}: ${o.guidance}`)
          .join('\n');

        const correctionMessage = [
          '## Human Reviewer Guidance',
          '',
          'The human reviewer provided the following instructions for recurring findings:',
          '',
          guidanceText,
          '',
          'Please address these items and try again.',
        ].join('\n');

        emitActivityStatus(podId, 'Resuming agent with human guidance…');
        transition(pod, 'running');

        try {
          const events = await taskFeedbackEvents(podId, correctionMessage, goalRework);
          const outcome = await this.consumeAgentEvents(podId, events, pod.validationAttempts);
          if (outcome === 'stopped') return;
          await persistRuntimeCredentialsForPod(
            podId,
            'Failed to persist rotated credentials after override-guidance resume',
          );
          if (outcome === 'completed') {
            await this.handleCompletion(podId);
          }
        } catch (err) {
          if (err instanceof AgentContinuationSupersededError) throw err;
          logger.error({ err, podId }, 'Failed to resume agent after override guidance');
          const s = podRepo.getOrThrow(podId);
          if (!isTerminalState(s.status)) {
            transition(s, 'failed');
          }
          throw err;
        }
      }

      logger.info(
        { podId, overrideCount: overrides.length, hasGuidance },
        'Validation override response processed',
      );
      return;
    }

    // ── Normal escalation responses ───────────────────────────────────
    const pendingForSession = deps.pendingRequestsByPod?.get(podId);
    const decisionId = pod.pendingEscalation?.id;
    const attachedWaiter = Boolean(
      decisionId &&
        pendingForSession?.hasPending(decisionId) &&
        !pendingForSession.isDetached(decisionId),
    );
    const retainedRun = podRepo.taskExecutions?.hasActiveRun(podId) ?? activeAgentRuns.has(podId);
    // An attached waiter is not proof that the MCP response reached the worker.
    const queueForRetainedRun = retainedRun || attachedWaiter;
    const queuedReply =
      pod.pendingEscalation && pendingForSession?.isDetached(pod.pendingEscalation.id)
        ? buildDetachedMcpFallbackMessage(pod.pendingEscalation.type, message)
        : message;
    persistCompletionReply(podRepo, pod, message, actor, () => {
      transition(pod, 'running', { pendingEscalation: null });
      if (queueForRetainedRun) nudgeRepo.queue(podId, queuedReply);
    });
    emitActivityStatus(podId, 'Human reply recorded.');

    // If the pod was blocked on an ask_human MCP call, resolve the pending request.
    // A still-attached MCP stream can deliver the response directly. If the
    // stream detached, resume the agent with the same fallback text queued for
    // check_messages so a dead or errored Codex turn is not stranded forever.
    let resumeMessage = message;
    if (pendingForSession && pod.pendingEscalation?.id) {
      const resolveResult = pendingForSession.resolveWithState(pod.pendingEscalation.id, message);
      if (resolveResult.resolved) {
        if (resolveResult.detached) {
          resumeMessage = buildDetachedMcpFallbackMessage(pod.pendingEscalation.type, message);
          if (!queueForRetainedRun) nudgeRepo.queue(podId, resumeMessage);
          emitActivityStatus(
            podId,
            'MCP response stream was closed — queued human reply for check_messages',
          );
        } else {
          // The MCP ask_human call has been unblocked — processPod's consumeAgentEvents
          // loop will continue picking up events from the still-running container.
          return;
        }
      }
    }

    if (queueForRetainedRun) {
      emitActivityStatus(
        podId,
        'Human reply saved for check_messages while the prior run is unresolved.',
      );
      return;
    }

    emitActivityStatus(podId, 'Resuming agent with message…');
    try {
      const resumeEnv = await getResumeEnv(pod);
      const runtime = runtimeRegistry.get(pod.runtime);
      if (!pod.containerId) throw new Error(`Pod ${podId} has no container`);
      const resumingPreservedSandbox =
        pod.lastRecoveryTrigger === 'restart' && pod.executionTarget === 'sandbox';
      if (resumingPreservedSandbox) {
        await containerManagerFactory.get('sandbox').start(pod.containerId);
        podRepo.update(podId, { lastRecoveryTrigger: null });
        emitActivityStatus(podId, 'Resuming preserved sandbox after daemon restart…');
      }
      await recordContinuationProvenance(pod, pod.containerId);
      const mcpServers = await primeRuntimeForResume(pod, runtime, pod.containerId, resumeEnv);
      let outcome: AgentRunOutcome;
      try {
        const events = runtime.resume(podId, resumeMessage, pod.containerId, resumeEnv);
        outcome = await this.consumeAgentEvents(podId, events, pod.validationAttempts);
      } catch (err) {
        if (!(resumingPreservedSandbox && err instanceof ResumeSessionNotFoundError)) throw err;
        if (!pod.worktreePath) throw err;
        podRepo.update(podId, { claudeSessionId: null });
        emitActivityStatus(
          podId,
          'Saved Claude session was unavailable — starting a fresh recovery worker in the preserved sandbox…',
        );
        const recoveryTask = await buildRecoveryTask(podRepo.getOrThrow(podId), pod.worktreePath);
        await recordContinuationProvenance(pod, pod.containerId);
        const recoveryEvents = runtime.spawn({
          podId,
          task: recoveryTask,
          model: pod.model,
          reasoningEffort: resolvedReasoningEffort(
            resolveEffectiveBoundProfile(pod),
            pod.profileSnapshot as unknown as Record<string, unknown> | null,
          ),
          workDir: '/workspace',
          containerId: pod.containerId,
          env: resumeEnv,
          mcpServers,
          executionTarget: pod.executionTarget,
        });
        outcome = await this.consumeAgentEvents(podId, recoveryEvents, pod.validationAttempts);
      }
      if (outcome === 'stopped') return;
      await persistRuntimeCredentialsForPod(
        podId,
        'Failed to persist rotated credentials after human-message resume',
      );
      if (outcome === 'completed') {
        await this.handleCompletion(podId);
      }
    } catch (err) {
      if (err instanceof AgentContinuationSupersededError) throw err;
      logger.error({ err, podId }, 'Failed to resume agent after message');
      const s = podRepo.getOrThrow(podId);
      if (!isTerminalState(s.status)) {
        transition(s, 'failed');
        emitActivityStatus(
          podId,
          `Resume failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      throw err;
    }
  }
  return { sendMessage };
}
