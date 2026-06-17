import type {
  PodBridge,
  PreSubmitReviewInput,
  PreSubmitReviewToolResult,
  SemanticValidationInput,
  SemanticValidationResult,
  ValidationPhaseName,
  ValidationPhaseResult,
} from '@autopod/escalation-mcp';
import type { PendingRequests } from '@autopod/escalation-mcp';
import type {
  ActionDefinition,
  ActionResponse,
  EscalationRequest,
  EscalationResponse,
  FactEvidence,
  MemoryEntry,
  MemoryOutcomeItem,
  MemoryScope,
  MemoryUsageEvent,
  MemoryUsageKind,
  MemoryUsageOutcome,
  PimActivationConfig,
  Profile,
  ReviewFeedbackResponseItem,
} from '@autopod/shared';
import { MAX_DIFF_LENGTH, generateId } from '@autopod/shared';
import type { Logger } from 'pino';
import type { ActionEngine } from '../actions/action-engine.js';
import { resolveEffectiveActionPolicy } from '../actions/policy-resolver.js';
import { isPrivateIp } from '../api/ssrf-guard.js';
import type { ContainerManager } from '../interfaces/container-manager.js';
import type { WorktreeManager } from '../interfaces/worktree-manager.js';
import type { ProfileStore } from '../profiles/index.js';
import { runContainerReviewer } from '../validation/container-reviewer-runner.js';
import type { HostBrowserRunner } from '../validation/host-browser-runner.js';
import {
  getPreSubmitCacheDecision,
  hashDiff,
  runPreSubmitReview,
} from '../validation/pre-submit-review.js';
import { runCodexReview } from '../validation/review-codex-runner.js';
import type { EscalationRepository } from './escalation-repository.js';
import type { EventBus } from './event-bus.js';
import type { MemoryRepository } from './memory-repository.js';
import type { MemoryUsageRepository } from './memory-usage-repository.js';
import type { NudgeRepository } from './nudge-repository.js';
import { computePodDiff, summarizeDiff } from './pod-diff-fetcher.js';
import type { ContainerManagerFactory, PodManager } from './pod-manager.js';
import type { PodRepository } from './pod-repository.js';
import type { ProgressEventRepository } from './progress-event-repository.js';
import { validatePlanAlignedProgress } from './progress-validation.js';
import { buildValidationExecEnv } from './registry-injector.js';
import { resolveReviewerModel, resolveReviewerProvider } from './runtime-resolver.js';

export interface SessionBridgeDependencies {
  podManager: PodManager;
  podRepo: PodRepository;
  eventBus: EventBus;
  progressEventRepo?: ProgressEventRepository;
  escalationRepo: EscalationRepository;
  nudgeRepo: NudgeRepository;
  profileStore: ProfileStore;
  memoryRepo?: MemoryRepository;
  memoryUsageRepo?: MemoryUsageRepository;
  makeActionEngine?: (profile: Profile) => ActionEngine;
  containerManagerFactory: ContainerManagerFactory;
  pendingRequestsByPod: Map<string, PendingRequests>;
  logger: Logger;
  hostBrowserRunner?: HostBrowserRunner;
  worktreeManager?: WorktreeManager;
  screenshotStore?: import('./screenshot-store.js').ScreenshotStore;
}

export function createSessionBridge(deps: SessionBridgeDependencies): PodBridge {
  const {
    podManager,
    podRepo,
    eventBus,
    progressEventRepo,
    escalationRepo,
    nudgeRepo,
    profileStore,
    memoryRepo,
    memoryUsageRepo,
    makeActionEngine,
    containerManagerFactory,
    pendingRequestsByPod: _pendingRequestsBySession,
    logger,
    hostBrowserRunner,
    worktreeManager,
    screenshotStore,
  } = deps;

  function assertAgentWriteAllowed(podId: string, toolName: string): void {
    const pod = podRepo.getOrThrow(podId);
    if (pod.status === 'running') return;

    logger.warn(
      { podId, status: pod.status, toolName },
      'Rejected agent MCP state write after pod left running state',
    );
    throw new Error(
      `${toolName} is only accepted while the pod is running (current status: ${pod.status}).`,
    );
  }

  return {
    createEscalation(escalation: EscalationRequest): void {
      podManager.touchHeartbeat(escalation.podId);
      escalationRepo.insert(escalation);
      logger.info(
        { escalationId: escalation.id, podId: escalation.podId, type: escalation.type },
        'Escalation created',
      );
      // Transition pod to awaiting_input so the TUI shows the pending question/approval
      if (
        escalation.type === 'ask_human' ||
        escalation.type === 'report_blocker' ||
        escalation.type === 'action_approval' ||
        escalation.type === 'request_credential'
      ) {
        podManager.notifyEscalation(escalation.podId, escalation);
      }
    },

    resolveEscalation(escalationId: string, response: EscalationResponse): void {
      escalationRepo.update(escalationId, response);
      logger.info({ escalationId }, 'Escalation resolved');
    },

    getAiEscalationCount(podId: string): number {
      return escalationRepo.countBySessionAndType(podId, 'ask_ai');
    },

    getMaxAiCalls(podId: string): number {
      const pod = podManager.getSession(podId);
      const profile = profileStore.get(pod.profileName);
      return profile.escalation?.askAi.maxCalls ?? 5;
    },

    getAutoPauseThreshold(podId: string): number {
      const pod = podManager.getSession(podId);
      const profile = profileStore.get(pod.profileName);
      return profile.escalation?.autoPauseAfter ?? 3;
    },

    getHumanResponseTimeout(podId: string): number {
      const pod = podManager.getSession(podId);
      const profile = profileStore.get(pod.profileName);
      return profile.escalation?.humanResponseTimeout ?? 3600;
    },

    getHumanResponseOnTimeout(podId: string): 'continue' | 'ask_ai' {
      const pod = podManager.getSession(podId);
      const profile = profileStore.get(pod.profileName);
      return profile.escalation?.askHumanOnTimeout ?? 'continue';
    },

    logEscalationAnswer(podId: string, who: 'human' | 'ai', answer: string): void {
      logger.info({ pod: podId, who, answer }, 'Escalation answer received');
    },

    getReviewerModel(podId: string): string {
      const pod = podManager.getSession(podId);
      const profile = profileStore.get(pod.profileName);
      return resolveReviewerModel(profile, logger);
    },

    async callReviewerModel(podId: string, question: string, context?: string): Promise<string> {
      const pod = podManager.getSession(podId);
      const profile = profileStore.get(pod.profileName);
      const model = resolveReviewerModel(profile, logger);

      // Enrich the prompt with pod state so the reviewer has full context
      // beyond what the agent manually passes.
      const contextParts: string[] = [];

      contextParts.push(`Task: ${pod.task}`);

      if (pod.plan) {
        contextParts.push(`Plan: ${pod.plan.summary}`);
        if (pod.plan.steps.length > 0) {
          contextParts.push(
            `Steps:\n${pod.plan.steps.map((s, i) => `  ${i + 1}. ${s}`).join('\n')}`,
          );
        }
      }

      if (pod.progress) {
        contextParts.push(
          `Progress: Phase ${pod.progress.currentPhase}/${pod.progress.totalPhases}` +
            ` — ${pod.progress.phase}: ${pod.progress.description}`,
        );
      }

      if (pod.commitCount > 0) {
        contextParts.push(`Commits so far: ${pod.commitCount}`);
      }

      if (context) {
        contextParts.push(`Agent-provided context:\n${context}`);
      }

      const prompt = `${contextParts.join('\n\n')}\n\nQuestion:\n${question}`;

      logger.info(
        {
          podId,
          model,
          provider: resolveReviewerProvider(profile),
          question: question.slice(0, 100),
        },
        'Calling reviewer model',
      );

      try {
        if (!pod.containerId) {
          return 'AI review failed: AI reviewer requires a live pod container';
        }
        const cm = containerManagerFactory.get(pod.executionTarget);
        const containerStatus = await cm.getStatus(pod.containerId);
        if (containerStatus !== 'running') {
          return 'AI review failed: AI reviewer requires a live pod container';
        }
        const reviewerExecEnv = await podManager.getReviewerExecEnv(pod);
        const { stdout } = await runContainerReviewer({
          podId,
          containerId: pod.containerId,
          containerManager: withReviewerExecEnv(cm, reviewerExecEnv),
          profile,
          model,
          prompt,
          timeout: 60_000,
          logger,
        });

        return stdout.trim();
      } catch (err) {
        logger.error({ err, podId }, 'Reviewer model call failed');
        return `AI review failed: ${err instanceof Error ? err.message : String(err)}`;
      }
    },

    async generateBrowserValidationScript(podId: string, prompt: string): Promise<string> {
      const pod = podManager.getSession(podId);
      const profile = profileStore.get(pod.profileName);
      const model = resolveReviewerModel(profile, logger);
      const cm = containerManagerFactory.get(pod.executionTarget);

      try {
        const { stdout } = await runContainerReviewer({
          podId,
          containerId: pod.containerId,
          containerManager: cm,
          profile,
          model,
          prompt,
          timeout: 60_000,
          logger,
        });
        return stdout.trim();
      } catch (err) {
        logger.error({ err, podId }, 'Browser validation script reviewer failed');
        throw err;
      }
    },

    incrementEscalationCount(podId: string): void {
      const pod = podManager.getSession(podId);
      // The pod manager tracks escalation count via pod updates
      // This is a no-op here since the pod manager handles it via consumeAgentEvents
      logger.debug({ podId, currentCount: pod.escalationCount }, 'Escalation count incremented');
    },

    reportPlan(
      podId: string,
      summary: string,
      steps: string[],
      memoryIntents?: Array<{ memoryId: string; reason: string }>,
    ): void {
      assertAgentWriteAllowed(podId, 'report_plan');
      podManager.touchHeartbeat(podId);
      const requiredMemoryIds = selectedMemoryIdsForPod(memoryUsageRepo, podId);
      if (requiredMemoryIds.length > 0 || memoryIntents?.length) {
        validateMemoryPlanIntents(requiredMemoryIds, memoryIntents);
      }
      for (const intent of memoryIntents ?? []) {
        recordMemoryUsage(memoryUsageRepo, podId, intent.memoryId, 'plan_reported', {
          outcome: 'intended',
          reason: intent.reason.trim(),
        });
      }
      logger.info(
        { podId, summary, stepCount: steps.length, memoryIntentCount: memoryIntents?.length ?? 0 },
        'Agent reported plan',
      );
      podRepo.update(podId, { plan: { summary, steps } });
      eventBus.emit({
        type: 'pod.agent_activity',
        timestamp: new Date().toISOString(),
        podId,
        event: { type: 'plan', summary, steps, timestamp: new Date().toISOString() },
      });
    },

    reportProgress(
      podId: string,
      phase: string,
      description: string,
      currentPhase: number,
      totalPhases: number,
    ): void {
      assertAgentWriteAllowed(podId, 'report_progress');
      podManager.touchHeartbeat(podId);
      const pod = podRepo.getOrThrow(podId);
      validatePlanAlignedProgress(pod.plan, { currentPhase, totalPhases });
      logger.info({ podId, phase, currentPhase, totalPhases }, 'Agent reported progress');
      podRepo.update(podId, {
        progress: { phase, description, currentPhase, totalPhases },
      });
      progressEventRepo?.insert(podId, phase, description, currentPhase, totalPhases);
      eventBus.emit({
        type: 'pod.agent_activity',
        timestamp: new Date().toISOString(),
        podId,
        event: {
          type: 'progress',
          phase,
          description,
          currentPhase,
          totalPhases,
          timestamp: new Date().toISOString(),
        },
      });
    },

    reportTaskSummary(
      podId: string,
      actualSummary: string,
      deviations: Array<{
        step: string;
        planned: string;
        actual: string;
        reason: string;
        kind?: 'constraint' | 'tradeoff' | 'scope' | 'bugfix' | 'other';
        impact?: string;
      }>,
      how?: string,
      factEvidence?: FactEvidence[],
      factDeviations?: Array<{
        factId: string;
        action: 'waive' | 'replace';
        reason: string;
        whyImpossible: string;
        decision?: 'approved_waive' | 'approved_replace' | 'rejected';
        replacement?: {
          artifactPath: string;
          command: string;
          proves?: string[];
        };
      }>,
      memoryOutcomes?: MemoryOutcomeItem[],
      reviewFeedbackResponses?: ReviewFeedbackResponseItem[],
    ): void {
      assertAgentWriteAllowed(podId, 'report_task_summary');
      podManager.touchHeartbeat(podId);
      const requiredMemoryIds = selectedMemoryIdsForPod(memoryUsageRepo, podId);
      if (requiredMemoryIds.length > 0 || memoryOutcomes?.length) {
        validateMemoryOutcomes(requiredMemoryIds, memoryOutcomes);
      }
      for (const outcome of memoryOutcomes ?? []) {
        recordMemoryUsage(memoryUsageRepo, podId, outcome.memoryId, 'summary_reported', {
          outcome: outcome.outcome,
          reason: outcome.reason.trim(),
        });
      }
      // Lock taskSummary on first write. Validation failures loop the same
      // pod back through running → validating, and the system prompt tells
      // the agent to call report_task_summary "as your very last step" each
      // time. Without this guard, the original task summary gets clobbered
      // by a fix-cycle summary like "Fixed the two medium-severity issues…".
      const existing = podRepo.getOrThrow(podId);
      const summaryAlreadySet = existing.taskSummary != null;
      logger.info(
        {
          podId,
          deviationCount: deviations.length,
          factEvidenceCount: factEvidence?.length ?? 0,
          factDeviationCount: factDeviations?.length ?? 0,
          memoryOutcomeCount: memoryOutcomes?.length ?? 0,
          reviewFeedbackResponseCount: reviewFeedbackResponses?.length ?? 0,
          actualSummary: actualSummary.slice(0, 100),
          preservedExistingSummary: summaryAlreadySet,
        },
        summaryAlreadySet
          ? 'Agent reported task summary again — preserving original, ignoring overwrite'
          : 'Agent reported task summary',
      );
      const updates: Parameters<typeof podRepo.update>[1] = {};
      if (!summaryAlreadySet) {
        updates.taskSummary = {
          actualSummary,
          how,
          deviations,
          factEvidence,
          factDeviations,
          memoryOutcomes,
          reviewFeedbackResponses,
        };
      } else if (
        existing.taskSummary &&
        (factEvidence != null ||
          factDeviations != null ||
          memoryOutcomes != null ||
          reviewFeedbackResponses != null)
      ) {
        updates.taskSummary = {
          ...existing.taskSummary,
          ...(factEvidence != null ? { factEvidence } : {}),
          ...(factDeviations != null ? { factDeviations } : {}),
          ...(memoryOutcomes != null ? { memoryOutcomes } : {}),
          ...(reviewFeedbackResponses != null ? { reviewFeedbackResponses } : {}),
        };
      }
      if (Object.keys(updates).length > 0) {
        podRepo.update(podId, updates);
      }
      eventBus.emit({
        type: 'pod.agent_activity',
        timestamp: new Date().toISOString(),
        podId,
        event: {
          type: 'task_summary',
          actualSummary,
          how,
          deviations,
          factEvidence,
          factDeviations,
          memoryOutcomes,
          reviewFeedbackResponses,
          timestamp: new Date().toISOString(),
        },
      });
    },

    consumeMessages(podId: string): { hasMessage: boolean; message?: string } {
      podManager.touchHeartbeat(podId);
      return nudgeRepo.consumeNext(podId);
    },

    actionRequiresApproval(podId: string, actionName: string): boolean {
      const pod = podManager.getSession(podId);
      const profile = profileStore.get(pod.profileName);
      if (!profile.actionPolicy) return false;
      const override = (profile.actionPolicy.actionOverrides ?? []).find(
        (o) => o.action === actionName && !o.disabled,
      );
      return override?.requiresApproval ?? false;
    },

    async executeAction(
      podId: string,
      actionName: string,
      params: Record<string, unknown>,
      options?: { skipApprovalCheck?: boolean },
    ): Promise<ActionResponse> {
      const pod = podManager.getSession(podId);
      const profile = profileStore.get(pod.profileName);

      if (!makeActionEngine) {
        return {
          success: false,
          error: 'Action engine not configured',
          sanitized: false,
          quarantined: false,
        };
      }

      const effectivePolicy = resolveEffectiveActionPolicy(profile);
      if (!effectivePolicy) {
        return {
          success: false,
          error: 'No action policy configured for this profile',
          sanitized: false,
          quarantined: false,
        };
      }

      // PIM actions: enforce that agents can only use groups pre-configured on the pod.
      // principal_id is always pod.userId — agents cannot supply or override it.
      let resolvedParams = params;
      if (actionName === 'activate_pim_group' || actionName === 'deactivate_pim_group') {
        const groupId = params.group_id as string | undefined;
        if (!groupId) {
          return {
            success: false,
            error: 'Missing required parameter: group_id',
            sanitized: false,
            quarantined: false,
          };
        }
        const allowed = pod.pimGroups ?? [];
        const match = allowed.find((g) => g.groupId === groupId);
        if (!match) {
          return {
            success: false,
            error: `PIM group '${groupId}' is not configured for this pod. Configured groups: ${allowed.map((g) => g.displayName ?? g.groupId).join(', ') || 'none'}`,
            sanitized: false,
            quarantined: false,
          };
        }
        resolvedParams = {
          ...params,
          principal_id: pod.userId,
          duration: match.duration ?? 'PT8H',
        };
      }
      if (actionName === 'list_pim_activations') {
        resolvedParams = { ...params, principal_id: pod.userId };
      }
      if (actionName === 'activate_pim_role' || actionName === 'deactivate_pim_role') {
        const scope = params.scope as string | undefined;
        const roleDefinitionId = params.role_definition_id as string | undefined;
        if (!scope || !roleDefinitionId) {
          return {
            success: false,
            error: 'Missing required parameters: scope, role_definition_id',
            sanitized: false,
            quarantined: false,
          };
        }
        const allowedRbac = (profile.pimActivations ?? []).filter(
          (a): a is Extract<PimActivationConfig, { type: 'rbac_role' }> => a.type === 'rbac_role',
        );
        const normScopeStr = (s: string) => (s.startsWith('/') ? s.slice(1) : s);
        const match = allowedRbac.find(
          (a) =>
            normScopeStr(a.scope) === normScopeStr(scope) &&
            a.roleDefinitionId === roleDefinitionId,
        );
        if (!match) {
          return {
            success: false,
            error: `PIM RBAC role '${roleDefinitionId}' at scope '${scope}' is not configured for this profile. Configured roles: ${allowedRbac.map((a) => a.displayName ?? a.roleDefinitionId).join(', ') || 'none'}`,
            sanitized: false,
            quarantined: false,
          };
        }
        resolvedParams = {
          ...params,
          principal_id: pod.userId,
          duration: match.duration ?? 'PT8H',
        };
      }

      const actionEngine = makeActionEngine(profile);
      logger.info({ podId, actionName }, 'Executing action via bridge');
      podManager.touchHeartbeat(podId);
      return actionEngine.execute(
        {
          podId,
          actionName,
          params: resolvedParams,
          skipApprovalCheck: options?.skipApprovalCheck,
          approvalContext: options?.approvalContext,
        },
        effectivePolicy,
      );
    },

    async getActionApprovalContext(
      podId: string,
      actionName: string,
      params: Record<string, unknown>,
    ): Promise<Record<string, unknown> | undefined> {
      if (actionName !== 'run_deploy_script') return undefined;

      const pod = podManager.getSession(podId);
      const profile = profileStore.get(pod.profileName);
      if (!profile.deployment?.enabled) return undefined;
      if (!pod.containerId) return undefined;

      const scriptPath = params.script_path;
      if (
        typeof scriptPath !== 'string' ||
        scriptPath.length === 0 ||
        scriptPath.startsWith('/') ||
        scriptPath.includes('..')
      ) {
        return undefined; // invalid path — let the handler emit the proper error
      }

      const { createHash } = await import('node:crypto');
      const cm = containerManagerFactory.get(pod.executionTarget);
      const scriptContent = await cm.readFile(pod.containerId, `/workspace/${scriptPath}`);
      const scriptHash = createHash('sha256').update(scriptContent, 'utf8').digest('hex');
      // Surface the baseline status so the human approval UI can flag scripts
      // that were modified during the pod session. The deploy handler enforces
      // the baseline check independently via `pod.deployBaselineHashes` — this
      // is purely informational for the reviewer.
      const baselineHash = pod.deployBaselineHashes?.[scriptPath] ?? null;
      const matchesBaseline = baselineHash !== null ? scriptHash === baselineHash : null;
      return { scriptContent, scriptHash, baselineHash, matchesBaseline };
    },

    getAvailableActions(podId: string): ActionDefinition[] {
      if (!makeActionEngine) return [];

      const pod = podManager.getSession(podId);
      const profile = profileStore.get(pod.profileName);

      const effectivePolicy = resolveEffectiveActionPolicy(profile);
      if (!effectivePolicy) return [];
      return makeActionEngine(profile).getAvailableActions(effectivePolicy);
    },

    async writeFileInContainer(podId: string, path: string, content: string): Promise<void> {
      podManager.touchHeartbeat(podId);
      const pod = podManager.getSession(podId);
      if (!pod.containerId) {
        throw new Error(`Pod ${podId} has no container`);
      }
      const cm = containerManagerFactory.get(pod.executionTarget);
      await cm.writeFile(pod.containerId, path, content);
    },

    async execInContainer(
      podId: string,
      command: string[],
      options?: { cwd?: string; timeout?: number },
    ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
      podManager.touchHeartbeat(podId);
      const pod = podManager.getSession(podId);
      if (!pod.containerId) {
        throw new Error(`Pod ${podId} has no container`);
      }
      const cm = containerManagerFactory.get(pod.executionTarget);
      return cm.execInContainer(pod.containerId, command, options);
    },

    getPreviewUrl(podId: string): string | null {
      const pod = podManager.getSession(podId);
      return pod.previewUrl ?? null;
    },

    async runBrowserOnHost(
      podId: string,
      script: string,
      timeout: number,
    ): Promise<{ stdout: string; stderr: string; exitCode: number } | null> {
      if (!hostBrowserRunner || !(await hostBrowserRunner.isAvailable())) {
        return null;
      }
      return hostBrowserRunner.runScript(script, { timeout, podId });
    },

    async readHostScreenshot(path: string): Promise<string | null> {
      if (!hostBrowserRunner) return null;
      try {
        return await hostBrowserRunner.readScreenshot(path);
      } catch {
        return null;
      }
    },

    async storeScreenshot(podId, source, filename, bytes) {
      if (!screenshotStore) {
        throw new Error('Screenshot store not available — daemon not wired with screenshotStore');
      }
      return screenshotStore.write(podId, source, filename, bytes);
    },

    getHostScreenshotDir(podId: string): string | null {
      if (!hostBrowserRunner) return null;
      return hostBrowserRunner.screenshotDir(podId);
    },

    getLinkedPodId(podId: string): string | null {
      const pod = podManager.getSession(podId);
      return pod.linkedPodId;
    },

    isAskHumanDisabled(podId: string): boolean {
      try {
        return podRepo.getOrThrow(podId).disableAskHuman;
      } catch {
        return false;
      }
    },

    async revalidateLinkedPod(
      linkedPodId: string,
    ): Promise<{ newCommits: boolean; result: 'pass' | 'fail' }> {
      logger.info({ linkedPodId }, 'Triggering revalidation of linked worker pod');
      return podManager.revalidateSession(linkedPodId);
    },

    async runSemanticValidation(
      podId: string,
      input: SemanticValidationInput,
    ): Promise<SemanticValidationResult> {
      podManager.touchHeartbeat(podId);
      return podManager.runSemanticValidation(podId, input);
    },

    listMemories(podId: string, scope: MemoryScope): MemoryEntry[] {
      if (!memoryRepo) return [];
      const pod = podManager.getSession(podId);
      const scopeId = scope === 'global' ? null : scope === 'profile' ? pod.profileName : podId;
      return memoryRepo.list(scope, scopeId, true);
    },

    readMemory(podId: string, id: string): MemoryEntry {
      if (!memoryRepo) throw new Error('Memory store not available');
      const entry = memoryRepo.getOrThrow(id);
      // Enforce scope boundary — the caller pod must be allowed to see this entry.
      // Without this check, a pod could read any memory by ID, including another
      // pod's private pod-scoped entries or unapproved pending suggestions.
      const pod = podManager.getSession(podId);
      const expectedScopeId =
        entry.scope === 'global' ? null : entry.scope === 'profile' ? pod.profileName : podId;
      if (entry.scopeId !== expectedScopeId) {
        throw new Error(`Memory ${id} is not readable from this pod`);
      }
      // Unapproved entries are only readable by the pod that suggested them.
      if (!entry.approved && entry.createdByPodId !== podId) {
        throw new Error(`Memory ${id} is pending approval`);
      }
      recordMemoryUsage(memoryUsageRepo, podId, entry.id, 'read');
      return entry;
    },

    searchMemories(podId: string, scope: MemoryScope, query: string): MemoryEntry[] {
      if (!memoryRepo) return [];
      const pod = podManager.getSession(podId);
      const scopeId = scope === 'global' ? null : scope === 'profile' ? pod.profileName : podId;
      const results = memoryRepo.search(query, scope, scopeId);
      for (const entry of results) {
        recordMemoryUsage(memoryUsageRepo, podId, entry.id, 'searched', {
          reason: `Matched memory_search query: ${query.slice(0, 200)}`,
        });
      }
      return results;
    },

    suggestMemory(
      podId: string,
      scope: MemoryScope,
      path: string,
      content: string,
      rationale: string,
    ): string {
      if (!memoryRepo) throw new Error('Memory store not available');
      const trimmedRationale = rationale.trim();
      if (!trimmedRationale) {
        throw new Error(
          'Memory suggestion rejected: rationale is required and must name the specific future-pod scenario this saves. If you cannot articulate the stuck moment concretely, do not suggest the memory.',
        );
      }
      // Rate-limit agent-sourced suggestions per pod to curb approval-fatigue
      // prompt-injection attacks on the global/profile memory pool.
      if (scope !== 'pod') {
        const limit = consumeSuggestBudget(podId);
        if (limit.denied) {
          throw new Error(
            `Memory suggestion rate limit exceeded (${SUGGEST_LIMIT_PER_WINDOW} per ${SUGGEST_WINDOW_MS / 60_000}m). Retry after ${limit.retryAfterSeconds}s.`,
          );
        }
      }
      const pod = podManager.getSession(podId);
      const scopeId = scope === 'global' ? null : scope === 'profile' ? pod.profileName : podId;
      const id = generateId(8);
      // Pod-scoped memories are ephemeral working notes — auto-approve to avoid
      // interrupting users for things that only affect a single pod run.
      const approved = scope === 'pod';
      const entry = memoryRepo.insert({
        id,
        scope,
        scopeId,
        path,
        content,
        rationale: trimmedRationale,
        approved,
        createdByPodId: podId,
      });
      if (!approved) {
        eventBus.emit({
          type: 'memory.suggestion_created',
          podId,
          memoryEntry: entry,
          timestamp: new Date().toISOString(),
        });
      }
      logger.info(
        { podId, memoryId: entry.id, scope, path, approved },
        'Memory suggestion created',
      );
      return entry.id;
    },

    async runPreSubmitReview(
      podId: string,
      input: PreSubmitReviewInput,
    ): Promise<PreSubmitReviewToolResult> {
      podManager.touchHeartbeat(podId);
      const pod = podManager.getSession(podId);
      const profile = profileStore.get(pod.profileName);
      const reviewerModel = resolveReviewerModel(profile, logger);
      const reviewerProvider = resolveReviewerProvider(profile);
      const defaultBranch = profile.defaultBranch ?? 'main';

      // Read the diff from inside the live container when possible — the
      // host worktree is only synced at validation/handoff checkpoints, so
      // mid-run it is stale and would hide every commit the agent has made.
      // Falls back to the host worktree if the container is gone.
      const containerManager = pod.containerId
        ? containerManagerFactory.get(pod.executionTarget)
        : undefined;
      const { diff, source: diffSource } = await computePodDiff({
        pod: {
          containerId: pod.containerId ?? null,
          worktreePath: pod.worktreePath ?? null,
          startCommitSha: pod.startCommitSha ?? null,
        },
        defaultBranch,
        containerManager,
        worktreeManager,
        maxLength: MAX_DIFF_LENGTH,
        logger,
      });

      const scope = summarizeDiff(diff);
      const startedAt = Date.now();

      // Short-circuit identical-diff re-calls. Without this, an agent that
      // re-runs pre_submit_review with "clarified" inputs (but the same diff
      // bytes) burns reviewer tokens and risks getting a different verdict
      // due to LLM nondeterminism — deepening the confusion that motivated
      // the re-call in the first place.
      const currentDiffHash = hashDiff(diff);
      const cached = pod.preSubmitReview;
      const currentCacheScope = {
        diffHash: currentDiffHash,
        diffSource,
        filesReviewed: scope.filesReviewed,
        linesAdded: scope.linesAdded,
        linesRemoved: scope.linesRemoved,
        containerId: pod.containerId ?? null,
        worktreePath: pod.worktreePath ?? null,
        startCommitSha: pod.startCommitSha ?? null,
      };
      const cacheDecision = getPreSubmitCacheDecision(cached, currentCacheScope, {
        requireMetadata: [
          'diffSource',
          'filesReviewed',
          'linesAdded',
          'linesRemoved',
          'containerId',
          'worktreePath',
          'startCommitSha',
        ],
      });
      if (diff && cached && cacheDecision.reusable) {
        logger.info(
          { podId, diffHash: currentDiffHash, diffSource, status: cached.status },
          'pre-submit review: returning cached verdict for unchanged diff',
        );
        return {
          status: cached.status,
          reasoning: cached.reasoning,
          issues: cached.issues,
          ...(cached.status === 'skipped' ? { skipReason: 'cached' } : {}),
          model: cached.model,
          durationMs: Date.now() - startedAt,
          filesReviewed: scope.filesReviewed,
          linesAdded: scope.linesAdded,
          linesRemoved: scope.linesRemoved,
          reusedCache: true,
          cachedMetadata: {
            diffSource: cached.diffSource,
            filesReviewed: cached.filesReviewed,
            linesAdded: cached.linesAdded,
            linesRemoved: cached.linesRemoved,
            startCommitSha: cached.startCommitSha,
          },
        };
      }
      if (diff && cached && !cacheDecision.reusable) {
        logger.info(
          {
            podId,
            reason: cacheDecision.reason,
            cachedStatus: cached.status,
            cachedDiffHash: cached.diffHash,
            currentDiffHash,
            cachedSource: cached.diffSource,
            currentSource: diffSource,
            cachedFilesReviewed: cached.filesReviewed,
            currentFilesReviewed: scope.filesReviewed,
            cachedLinesAdded: cached.linesAdded,
            currentLinesAdded: scope.linesAdded,
            cachedLinesRemoved: cached.linesRemoved,
            currentLinesRemoved: scope.linesRemoved,
            cachedContainerId: cached.containerId,
            currentContainerId: pod.containerId ?? null,
            cachedWorktreePath: cached.worktreePath,
            currentWorktreePath: pod.worktreePath ?? null,
            cachedStartCommitSha: cached.startCommitSha,
            currentStartCommitSha: pod.startCommitSha ?? null,
          },
          'pre-submit review: ignoring cached verdict',
        );
      }

      const result = await runPreSubmitReview(
        {
          task: pod.task ?? '',
          diff,
          reviewerModel,
          reviewerProvider,
          reviewerProviderCredentials: profile.providerCredentials,
          podId,
          containerId: pod.containerId,
          containerManager,
          plannedSummary: input.plannedSummary,
          plannedDeviations: input.plannedDeviations,
        },
        logger,
      );

      // Cache the verdict on the pod so the daemon's full reviewer can skip
      // Tier 1 when the diff hasn't changed since this pre-submit pass.
      try {
        podRepo.update(podId, {
          preSubmitReview: {
            status: result.status,
            diffHash: result.diffHash,
            diffSource,
            filesReviewed: scope.filesReviewed,
            linesAdded: scope.linesAdded,
            linesRemoved: scope.linesRemoved,
            containerId: pod.containerId ?? null,
            worktreePath: pod.worktreePath ?? null,
            startCommitSha: pod.startCommitSha ?? null,
            issues: result.issues,
            reasoning: result.reasoning,
            model: result.model,
            checkedAt: new Date().toISOString(),
          },
        });
      } catch (err) {
        logger.warn({ err, podId }, 'pre-submit review: failed to cache verdict');
      }

      return {
        status: result.status,
        reasoning: result.reasoning,
        issues: result.issues,
        ...(result.skipReason ? { skipReason: result.skipReason } : {}),
        model: result.model,
        durationMs: result.durationMs,
        filesReviewed: scope.filesReviewed,
        linesAdded: scope.linesAdded,
        linesRemoved: scope.linesRemoved,
      };
    },

    async runValidationPhase(
      podId: string,
      phase: ValidationPhaseName,
    ): Promise<ValidationPhaseResult> {
      podManager.touchHeartbeat(podId);
      const pod = podManager.getSession(podId);
      if (!pod.containerId) {
        throw new Error(`Pod ${podId} has no container`);
      }
      const profile = profileStore.get(pod.profileName);

      const phaseConfig = resolveValidationPhase(phase, profile);
      if (!phaseConfig.command) {
        return {
          phase,
          configured: false,
          passed: false,
          exitCode: null,
          command: null,
          durationMs: 0,
          output: '',
        };
      }

      const cwd = profile.buildWorkDir ? `/workspace/${profile.buildWorkDir}` : '/workspace';
      const env = buildValidationExecEnv(
        profile.privateRegistries,
        profile.registryPat ?? profile.adoPat ?? null,
        profile.buildEnv,
      );
      const cm = containerManagerFactory.get(pod.executionTarget);

      const startedAt = Date.now();
      try {
        const result = await cm.execInContainer(
          pod.containerId,
          ['sh', '-c', phaseConfig.command],
          {
            cwd,
            timeout: phaseConfig.timeoutMs,
            ...(env ? { env } : {}),
          },
        );
        const durationMs = Date.now() - startedAt;
        const combined = `${result.stdout}\n${result.stderr}`.trim();
        return {
          phase,
          configured: true,
          passed: result.exitCode === 0,
          exitCode: result.exitCode,
          command: phaseConfig.command,
          durationMs,
          output: truncateOutput(combined),
        };
      } catch (err) {
        const durationMs = Date.now() - startedAt;
        const message = err instanceof Error ? err.message : String(err);
        const partial = (err as { partialOutput?: string })?.partialOutput ?? '';
        return {
          phase,
          configured: true,
          passed: false,
          exitCode: null,
          command: phaseConfig.command,
          durationMs,
          output: truncateOutput(
            partial ? `${message}\n\n--- partial output ---\n${partial}` : message,
          ),
        };
      }
    },

    validateBrowserUrl(_podId: string, url: string): void {
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        throw new Error(`validate_in_browser: invalid URL: ${url}`);
      }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new Error(
          `validate_in_browser: only http(s) URLs are allowed. Got: ${parsed.protocol}`,
        );
      }
      const hostname = parsed.hostname.replace(/^\[|\]$/g, '');
      // Allow only localhost / 127.0.0.1; block all other addresses including
      // private IP ranges and cloud metadata services.
      const isLoopbackFqdn = hostname === 'localhost';
      const isLoopbackIpv4 = /^\d+\.\d+\.\d+\.\d+$/.test(hostname) && hostname.startsWith('127.');
      const isPrivate = isPrivateIp(hostname);
      if (!isLoopbackFqdn && !isLoopbackIpv4) {
        if (isPrivate) {
          throw new Error(
            `validate_in_browser: private/metadata addresses are not allowed. Got: ${hostname}`,
          );
        }
        throw new Error(
          `validate_in_browser: only localhost or 127.x addresses are allowed. Got: ${hostname}`,
        );
      }
    },
  };
}

// Per-pod rate limit for non-pod scope suggestions. In-memory only —
// this is a defensive bound against a single pod spamming the approval queue,
// not a durable policy control.
const SUGGEST_LIMIT_PER_WINDOW = 5;
const SUGGEST_WINDOW_MS = 60 * 60 * 1000; // 1 hour
const suggestBudget = new Map<string, { count: number; windowStart: number }>();

function consumeSuggestBudget(podId: string): {
  denied: boolean;
  retryAfterSeconds: number;
} {
  const now = Date.now();
  const entry = suggestBudget.get(podId);
  if (!entry || now - entry.windowStart >= SUGGEST_WINDOW_MS) {
    suggestBudget.set(podId, { count: 1, windowStart: now });
    return { denied: false, retryAfterSeconds: 0 };
  }
  if (entry.count >= SUGGEST_LIMIT_PER_WINDOW) {
    const retryAfterSeconds = Math.ceil((entry.windowStart + SUGGEST_WINDOW_MS - now) / 1000);
    return { denied: true, retryAfterSeconds };
  }
  entry.count += 1;
  return { denied: false, retryAfterSeconds: 0 };
}

/** Test-only: reset the per-pod suggestion rate-limit window. */
export function __resetSuggestBudgetForTests(): void {
  suggestBudget.clear();
}

function selectedMemoryIdsForPod(
  usageRepo: MemoryUsageRepository | undefined,
  podId: string,
): string[] {
  if (!usageRepo) return [];
  const ids = new Set<string>();
  for (const event of usageRepo.listByPod(podId)) {
    if (event.kind === 'selected' || event.kind === 'injected') {
      ids.add(event.memoryId);
    }
  }
  return [...ids].sort();
}

function validateMemoryPlanIntents(
  requiredMemoryIds: string[],
  intents: Array<{ memoryId: string; reason: string }> | undefined,
): void {
  validateMemoryReportItems({
    requiredMemoryIds,
    items: intents,
    fieldName: 'memoryIntents',
    outcomeRequired: false,
  });
}

function validateMemoryOutcomes(
  requiredMemoryIds: string[],
  outcomes: MemoryOutcomeItem[] | undefined,
): void {
  validateMemoryReportItems({
    requiredMemoryIds,
    items: outcomes,
    fieldName: 'memoryOutcomes',
    outcomeRequired: true,
  });
}

function validateMemoryReportItems(args: {
  requiredMemoryIds: string[];
  items: Array<{ memoryId: string; reason: string; outcome?: string }> | undefined;
  fieldName: 'memoryIntents' | 'memoryOutcomes';
  outcomeRequired: boolean;
}): void {
  const { requiredMemoryIds, items, fieldName, outcomeRequired } = args;
  if (!items) {
    throw new Error(
      `${fieldName} is required because selected/injected memories exist. Include one item per memory: ${requiredMemoryIds.join(', ')}.`,
    );
  }

  const required = new Set(requiredMemoryIds);
  const seen = new Set<string>();
  const invalid: string[] = [];
  for (const item of items) {
    if (!required.has(item.memoryId)) {
      invalid.push(item.memoryId);
      continue;
    }
    if (seen.has(item.memoryId)) {
      throw new Error(`${fieldName} contains duplicate memoryId: ${item.memoryId}`);
    }
    seen.add(item.memoryId);
    if (!item.reason.trim()) {
      throw new Error(`${fieldName} reason is required for memoryId: ${item.memoryId}`);
    }
    if (
      outcomeRequired &&
      item.outcome !== 'applied' &&
      item.outcome !== 'not_applicable' &&
      item.outcome !== 'harmful_stale'
    ) {
      throw new Error(
        `${fieldName} outcome for memoryId ${item.memoryId} must be applied, not_applicable, or harmful_stale.`,
      );
    }
  }

  if (invalid.length > 0) {
    throw new Error(
      `${fieldName} references memory IDs that were not selected/injected for this pod: ${invalid.join(', ')}.`,
    );
  }

  const missing = requiredMemoryIds.filter((id) => !seen.has(id));
  if (missing.length > 0) {
    throw new Error(`${fieldName} is missing selected/injected memory IDs: ${missing.join(', ')}.`);
  }
}

function recordMemoryUsage(
  usageRepo: MemoryUsageRepository | undefined,
  podId: string,
  memoryId: string,
  kind: MemoryUsageKind,
  options?: {
    outcome?: MemoryUsageOutcome;
    reason?: string;
    relevanceReason?: string;
  },
): MemoryUsageEvent | undefined {
  return usageRepo?.record({
    id: generateId(8),
    memoryId,
    podId,
    kind,
    outcome: options?.outcome ?? null,
    reason: options?.reason ?? null,
    relevanceReason: options?.relevanceReason ?? null,
  });
}

function withReviewerExecEnv(
  containerManager: ContainerManager,
  reviewerExecEnv: Record<string, string> | undefined,
): ContainerManager {
  if (!reviewerExecEnv) return containerManager;

  return {
    spawn(config) {
      return containerManager.spawn(config);
    },
    kill(containerId) {
      return containerManager.kill(containerId);
    },
    refreshFirewall(containerId, script) {
      return containerManager.refreshFirewall(containerId, script);
    },
    stop(containerId) {
      return containerManager.stop(containerId);
    },
    start(containerId) {
      return containerManager.start(containerId);
    },
    writeFile(containerId, path, content) {
      return containerManager.writeFile(containerId, path, content);
    },
    readFile(containerId, path) {
      return containerManager.readFile(containerId, path);
    },
    readFileBinary(containerId, path) {
      return containerManager.readFileBinary(containerId, path);
    },
    extractDirectoryFromContainer(containerId, containerPath, hostPath, excludes) {
      return containerManager.extractDirectoryFromContainer(
        containerId,
        containerPath,
        hostPath,
        excludes,
      );
    },
    getStatus(containerId) {
      return containerManager.getStatus(containerId);
    },
    execInContainer(containerId, command, options) {
      return containerManager.execInContainer(containerId, command, {
        ...options,
        env: { ...reviewerExecEnv, ...options?.env },
      });
    },
    execStreaming(containerId, command, options) {
      return containerManager.execStreaming(containerId, command, options);
    },
  };
}

const VALIDATE_LOCALLY_OUTPUT_BUDGET = 6_000;

/**
 * Truncate combined stdout+stderr to fit the agent's context.
 *
 * Failures usually surface near the end of build/test output, so we keep the
 * tail and drop the middle when the output is large. The head is retained too
 * because some failures (Biome rule errors, lint errors with file paths) are
 * easier to grok with a bit of preamble showing the command's shape.
 */
function truncateOutput(text: string): string {
  if (text.length <= VALIDATE_LOCALLY_OUTPUT_BUDGET) return text;
  const headLen = 1_000;
  const tailLen = VALIDATE_LOCALLY_OUTPUT_BUDGET - headLen - 80;
  const omitted = text.length - headLen - tailLen;
  const head = text.slice(0, headLen);
  const tail = text.slice(text.length - tailLen);
  return `${head}\n\n... [truncated ${omitted} chars in the middle] ...\n\n${tail}`;
}

interface ResolvedPhase {
  command: string | null;
  timeoutMs: number;
}

function resolveValidationPhase(phase: ValidationPhaseName, profile: Profile): ResolvedPhase {
  switch (phase) {
    case 'setup':
      return {
        command: profile.skipValidationPhases?.includes('setup')
          ? null
          : (profile.validationSetupCommand?.trim() ?? null),
        timeoutMs: (profile.buildTimeout ?? 300) * 1_000,
      };
    case 'lint':
      return {
        command: profile.lintCommand ?? null,
        timeoutMs: (profile.lintTimeout ?? 120) * 1_000,
      };
    case 'build':
      return {
        command: profile.buildCommand ?? null,
        timeoutMs: (profile.buildTimeout ?? 300) * 1_000,
      };
    case 'tests':
      return {
        command: profile.testCommand ?? null,
        timeoutMs: (profile.testTimeout ?? 600) * 1_000,
      };
  }
}
