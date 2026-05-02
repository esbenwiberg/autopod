import type {
  PodBridge,
  PreSubmitReviewInput,
  PreSubmitReviewToolResult,
  ValidationPhaseName,
  ValidationPhaseResult,
} from '@autopod/escalation-mcp';
import type { PendingRequests } from '@autopod/escalation-mcp';
import type {
  ActionDefinition,
  ActionResponse,
  EscalationRequest,
  EscalationResponse,
  MemoryEntry,
  MemoryScope,
  PimActivationConfig,
  Profile,
} from '@autopod/shared';
import { MAX_DIFF_LENGTH, generateId } from '@autopod/shared';
import type { Logger } from 'pino';
import type { ActionEngine } from '../actions/action-engine.js';
import { resolveEffectiveActionPolicy } from '../actions/policy-resolver.js';
import { isPrivateIp } from '../api/ssrf-guard.js';
import type { WorktreeManager } from '../interfaces/worktree-manager.js';
import type { ProfileStore } from '../profiles/index.js';
import type { HostBrowserRunner } from '../validation/host-browser-runner.js';
import { runPreSubmitReview } from '../validation/pre-submit-review.js';
import type { EscalationRepository } from './escalation-repository.js';
import type { EventBus } from './event-bus.js';
import type { MemoryRepository } from './memory-repository.js';
import type { NudgeRepository } from './nudge-repository.js';
import { evaluatePlanAgainstAc } from './plan-evaluator.js';
import type { ContainerManagerFactory, PodManager } from './pod-manager.js';
import type { PodRepository } from './pod-repository.js';
import type { ProgressEventRepository } from './progress-event-repository.js';
import { buildValidationExecEnv } from './registry-injector.js';

export interface SessionBridgeDependencies {
  podManager: PodManager;
  podRepo: PodRepository;
  eventBus: EventBus;
  progressEventRepo?: ProgressEventRepository;
  escalationRepo: EscalationRepository;
  nudgeRepo: NudgeRepository;
  profileStore: ProfileStore;
  memoryRepo?: MemoryRepository;
  makeActionEngine?: (profile: Profile) => ActionEngine;
  containerManagerFactory: ContainerManagerFactory;
  pendingRequestsByPod: Map<string, PendingRequests>;
  logger: Logger;
  hostBrowserRunner?: HostBrowserRunner;
  worktreeManager?: WorktreeManager;
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
    makeActionEngine,
    containerManagerFactory,
    pendingRequestsByPod: _pendingRequestsBySession,
    logger,
    hostBrowserRunner,
    worktreeManager,
  } = deps;

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

    getReviewerModel(podId: string): string {
      const pod = podManager.getSession(podId);
      const profile = profileStore.get(pod.profileName);
      return profile.escalation?.askAi.model ?? 'sonnet';
    },

    async callReviewerModel(podId: string, question: string, context?: string): Promise<string> {
      const model = this.getReviewerModel(podId);
      const pod = podManager.getSession(podId);

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

      logger.info({ podId, model, question: question.slice(0, 100) }, 'Calling reviewer model');

      try {
        const { execFile } = await import('node:child_process');
        const { promisify } = await import('node:util');
        const execFileAsync = promisify(execFile);

        const { stdout } = await execFileAsync(
          'claude',
          ['-p', prompt, '--model', model, '--output-format', 'text'],
          { timeout: 60_000 },
        );

        return stdout.trim();
      } catch (err) {
        logger.error({ err, podId }, 'Reviewer model call failed');
        return `AI review failed: ${err instanceof Error ? err.message : String(err)}`;
      }
    },

    incrementEscalationCount(podId: string): void {
      const pod = podManager.getSession(podId);
      // The pod manager tracks escalation count via pod updates
      // This is a no-op here since the pod manager handles it via consumeAgentEvents
      logger.debug({ podId, currentCount: pod.escalationCount }, 'Escalation count incremented');
    },

    reportPlan(podId: string, summary: string, steps: string[]): void {
      podManager.touchHeartbeat(podId);
      logger.info({ podId, summary, stepCount: steps.length }, 'Agent reported plan');
      podRepo.update(podId, { plan: { summary, steps } });
      eventBus.emit({
        type: 'pod.agent_activity',
        timestamp: new Date().toISOString(),
        podId,
        event: { type: 'plan', summary, steps, timestamp: new Date().toISOString() },
      });

      // Fire-and-forget plan evaluation against AC when the profile opts in.
      const pod = podManager.getSession(podId);
      const profile = profileStore.get(pod.profileName);
      if (profile.evaluatePlan && pod.acceptanceCriteria?.length) {
        evaluatePlanAgainstAc(summary, steps, pod.acceptanceCriteria, profile, logger)
          .then((feedback) => {
            if (feedback) {
              nudgeRepo.queue(podId, `**Plan review:** ${feedback}`);
            }
          })
          .catch((err) => logger.warn({ err, podId }, 'Plan evaluation failed'));
      }
    },

    reportProgress(
      podId: string,
      phase: string,
      description: string,
      currentPhase: number,
      totalPhases: number,
    ): void {
      podManager.touchHeartbeat(podId);
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
      deviations: Array<{ step: string; planned: string; actual: string; reason: string }>,
      how?: string,
      acChecklist?: Array<{ criterion: string; verified: boolean; notes?: string }>,
    ): void {
      podManager.touchHeartbeat(podId);
      logger.info(
        {
          podId,
          deviationCount: deviations.length,
          acChecklistCount: acChecklist?.length ?? 0,
          actualSummary: actualSummary.slice(0, 100),
        },
        'Agent reported task summary',
      );
      podRepo.update(podId, {
        taskSummary: { actualSummary, how, deviations },
        ...(acChecklist != null ? { acSelfReport: acChecklist } : {}),
      });
      eventBus.emit({
        type: 'pod.agent_activity',
        timestamp: new Date().toISOString(),
        podId,
        event: {
          type: 'task_summary',
          actualSummary,
          how,
          deviations,
          acChecklist,
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
      return entry;
    },

    searchMemories(podId: string, scope: MemoryScope, query: string): MemoryEntry[] {
      if (!memoryRepo) return [];
      const pod = podManager.getSession(podId);
      const scopeId = scope === 'global' ? null : scope === 'profile' ? pod.profileName : podId;
      return memoryRepo.search(query, scope, scopeId);
    },

    suggestMemory(
      podId: string,
      scope: MemoryScope,
      path: string,
      content: string,
      rationale?: string,
    ): string {
      if (!memoryRepo) throw new Error('Memory store not available');
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
        rationale: rationale ?? null,
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
      const reviewerModel = profile.reviewerModel || profile.defaultModel || 'sonnet';

      let diff = '';
      if (worktreeManager && pod.worktreePath) {
        try {
          diff = await worktreeManager.getDiff(
            pod.worktreePath,
            profile.defaultBranch ?? 'main',
            MAX_DIFF_LENGTH,
            pod.startCommitSha ?? undefined,
          );
        } catch (err) {
          logger.warn({ err, podId }, 'pre-submit review: failed to fetch diff');
        }
      }

      const result = await runPreSubmitReview(
        {
          task: pod.task ?? '',
          diff,
          reviewerModel,
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
