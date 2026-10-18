import type { AgentEvent, Pod } from '@autopod/shared';
import { AutopodError } from '@autopod/shared';
import type { ContinuationCaptured, ContinuationLiveDependencies } from './continuation-ports.js';
import { preflightAgentContinuation } from './continuation-preflight.js';
import { resolvedReasoningEffort } from './provider-attempt-policy.js';
import {
  buildContinuationPrompt as buildContinuationPromptFromWorktree,
  buildRecoveryTask as buildRecoveryTaskFromWorktree,
  buildReworkTask as buildReworkTaskFromWorktree,
} from './recovery-context.js';
import { generateSystemInstructions } from './system-instructions-generator.js';

type Captured = Pick<
  ContinuationCaptured,
  | 'podRepo'
  | 'nudgeRepo'
  | 'containerManagerFactory'
  | 'runtimeRegistry'
  | 'mcpBaseUrl'
  | 'executionForPod'
  | 'primeRuntimeForResume'
  | 'resolveEffectiveBoundProfile'
  | 'getResumeEnv'
  | 'emitActivityStatus'
>;

export function createContinuationContext(deps: ContinuationLiveDependencies, captured: Captured) {
  const {
    podRepo,
    nudgeRepo,
    containerManagerFactory,
    runtimeRegistry,
    mcpBaseUrl,
    executionForPod,
    primeRuntimeForResume,
    resolveEffectiveBoundProfile,
    getResumeEnv,
    emitActivityStatus,
  } = captured;

  function appendDecisionContext(pod: Pod, task: string): string {
    return (
      task +
      (podRepo.completionJournal?.recoveryContext(pod) ?? '') +
      (nudgeRepo.hasPending(pod.id)
        ? '\n\nUncollected human guidance remains in check_messages. Read all queued messages, acknowledge each deliveryId with acknowledge_messages, reconcile them with the preserved work, and apply them before reporting completion.'
        : '')
    );
  }

  async function buildRecoveryTask(pod: Pod, worktreePath: string): Promise<string> {
    return appendDecisionContext(pod, await buildRecoveryTaskFromWorktree(pod, worktreePath));
  }

  async function buildContinuationPrompt(pod: Pod, worktreePath: string): Promise<string> {
    return appendDecisionContext(pod, await buildContinuationPromptFromWorktree(pod, worktreePath));
  }

  async function buildReworkTask(pod: Pod, worktreePath: string, reason: string): Promise<string> {
    return appendDecisionContext(pod, await buildReworkTaskFromWorktree(pod, worktreePath, reason));
  }

  async function recordContinuationProvenance(pod: Pod, containerId: string): Promise<void> {
    await preflightAgentContinuation(pod, containerId, {
      containerManager: containerManagerFactory.get(pod.executionTarget),
      readCurrent: () => podRepo.getOrThrow(pod.id),
      hasPendingDecision: () =>
        podRepo.hasUnansweredDecision?.(pod.id) ??
        Boolean(podRepo.getOrThrow(pod.id).pendingEscalation),
      resolveProfile: resolveEffectiveBoundProfile,
      provenance: podRepo.executionProvenance,
    });
  }

  async function beginGoalTaskRework(pod: Pod, task: string): Promise<boolean> {
    const configuration = deps.launchConfiguration;
    if (configuration?.read(pod.id)?.intent !== 'goal') return false;
    const goal = configuration.goals?.get(pod.id);
    if (goal?.state !== 'achieved' || !goal.executionStopped || !configuration.beginGoalRework)
      throw new AutopodError(
        'Achieve and stop the native Goal before Task rework',
        'GOAL_NOT_ACHIEVED',
        409,
      );
    await configuration.beginGoalRework(pod.id, task, (config) => {
      podRepo.update(pod.id, {
        task: config.task,
        profileSnapshot: null,
        claudeSessionId: null,
        codexSessionId: null,
        piSessionId: null,
      });
    });
    emitActivityStatus(
      pod.id,
      'Native Goal achievement retained. Starting separately recorded Task rework.',
    );
    return true;
  }

  async function taskFeedbackEvents(
    podId: string,
    message: string,
    fresh: boolean,
  ): Promise<AsyncIterable<AgentEvent>> {
    const pod = podRepo.getOrThrow(podId);
    if (!pod.containerId) throw new Error(`Pod ${podId} has no container`);
    const env = await getResumeEnv(pod);
    const runtime = runtimeRegistry.get(pod.runtime);
    await recordContinuationProvenance(pod, pod.containerId);
    const mcpServers = await primeRuntimeForResume(pod, runtime, pod.containerId, env);
    if (!fresh) return runtime.resume(podId, message, pod.containerId, env);
    const profile = executionForPod(pod);
    return runtime.spawn({
      podId,
      task: message,
      model: pod.model,
      reasoningEffort: resolvedReasoningEffort(profile),
      workDir: '/workspace',
      containerId: pod.containerId,
      env: env ?? {},
      mcpServers,
      customInstructions: generateSystemInstructions(profile, pod, `${mcpBaseUrl}/mcp/${podId}`),
      executionTarget: pod.executionTarget,
    });
  }

  return {
    appendDecisionContext,
    buildRecoveryTask,
    buildContinuationPrompt,
    buildReworkTask,
    recordContinuationProvenance,
    beginGoalTaskRework,
    taskFeedbackEvents,
  };
}
