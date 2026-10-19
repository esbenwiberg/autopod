import type {
  AgentEvent,
  CreatePodRequest,
  EffectiveLaunchConfig,
  EscalationRequest,
  HistoryQuery,
  InjectedMcpServer,
  OperatorActor,
  Pod,
  PodStatus,
  ProviderCredentials,
  ProviderFailoverTarget,
  SpawnFixResponse,
  UpdateFromBaseResponse,
} from '@autopod/shared';
import type { PodExecutionSettings } from '../interfaces/pod-execution-settings.js';
import type { AgentRunOutcome } from './agent-execution-contracts.js';
import type { ApproveAllSkippedPod, ApproveSessionOptions } from './approval-contracts.js';
import type { ArtifactResumeObservation } from './artifact-resume-observation.js';
import { createValidationTriggerCalls } from './pod-facade-calls.js';
import type { PodFacadeOwners } from './pod-facade-ports.js';
import type { PodStats } from './pod-repository.js';
import type { PodCreator } from './workspace-contracts.js';
export function createPodManagerFacade(captured: PodFacadeOwners) {
  const {
    admissionQueries,
    admissionResolved,
    admissionLegacy,
    admissionAnalysis,
    continuationControls,
    processWorkflow,
    agentEventConsumption,
    completionWorkflow,
    operatorMessages,
    approvalWorkflow,
    operatorRejection,
    operatorPause,
    operatorControls,
    operatorKill,
    workspacePromotion,
    workspaceCompletion,
    workspaceBranchSync,
    workspaceRecoveryCommands,
    validationTriggerWorkflow,
    validationRevalidationWorkflow,
    workspaceManualFix,
    touchHeartbeat,
    getEffectiveReviewerConfig,
    buildReviewerExecEnv,
    getReviewerExecutor,
    admissionMemory,
    workspaceDeletion,
    resourcePreviewControls,
    approvalControls,
    podRepo,
    validationEnvironmentForPod,
    executionForPod,
    admissionDependents,
    admissionSeries,
    validationWorkflowControls,
    fixControls,
    resourceNetwork,
    operatorTools,
    retryCreatePr,
    workspaceArtifactObservation,
    providerContinuation,
    workspaceEscapeControls,
    workspaceWatchdog,
  } = captured;
  return {
    getLaunchConfiguration(podId: string): EffectiveLaunchConfig | null {
      return admissionQueries.getLaunchConfiguration(podId);
    },
    createResolvedSession(
      config: EffectiveLaunchConfig,
      userId: string,
      creator?: PodCreator,
      actor?: OperatorActor,
    ): Pod {
      return admissionResolved.createResolvedSession(config, userId, creator, actor);
    },
    createSession(
      request: CreatePodRequest,
      userId: string,
      creator?: PodCreator,
      actor?: OperatorActor,
    ): Pod {
      return admissionLegacy.createSession(request, userId, creator, actor);
    },

    createHistoryWorkspace(
      profileName: string,
      userId: string,
      historyQuery: HistoryQuery,
      creator?: PodCreator,
    ): Pod {
      return admissionAnalysis.createHistoryWorkspace.call(
        this,
        profileName,
        userId,
        historyQuery,
        creator,
      );
    },

    createMemoryWorkspace(profileName: string, userId: string, creator?: PodCreator): Pod {
      return admissionAnalysis.createMemoryWorkspace.call(this, profileName, userId, creator);
    },
    resumeNativeGoal(podId: string, revision: number): Promise<void> {
      return continuationControls.resumeNativeGoal(podId, revision);
    },
    async processPod(podId: string): Promise<void> {
      return processWorkflow.processPod.call(this, podId);
    },

    async consumeAgentEvents(
      podId: string,
      events: AsyncIterable<AgentEvent>,
      attempt = 0,
      lifecycle?: { generation: number; containerId: string | null; nativeGoal?: boolean },
    ): Promise<AgentRunOutcome> {
      return agentEventConsumption.consumeAgentEvents(podId, events, attempt, lifecycle);
    },

    async handleCompletion(podId: string): Promise<void> {
      return completionWorkflow.handleCompletion.call(this, podId);
    },

    sendMessage(
      podId: string,
      message: string,
      actor: OperatorActor = { type: 'automation', id: 'direct-pod-manager' },
    ): Promise<void> {
      return operatorMessages.sendMessage.call(this, podId, message, actor);
    },

    approveSession(podId: string, options: ApproveSessionOptions = {}): Promise<void> {
      return approvalWorkflow.approveSession(podId, options);
    },

    rejectSession(
      podId: string,
      reason?: string,
      actor: OperatorActor = { type: 'automation', id: 'direct-pod-manager' },
    ): Promise<void> {
      return operatorRejection.rejectSession.call(this, podId, reason, actor);
    },

    pauseSession(podId: string): Promise<void> {
      return operatorPause.pauseSession(podId);
    },

    nudgeSession(podId: string, message: string): void {
      operatorControls.nudgeSession(podId, message);
    },

    killSession(podId: string): Promise<void> {
      return operatorKill.killSession(podId);
    },

    /**
     * Promote an interactive pod to an agent-driven (`auto`) pod on
     * the same pod ID. Keeps branch, event log, token budget, and
     * escalation history. Used when the human hands off work to the agent
     * via `ap complete <id> --pr` (or `--artifact`).
     *
     * Flow: sync `/workspace` back to host → stop interactive container →
     * transition to `handoff` → swap the pod's `pod` config → re-enqueue
     * for `processPod()` which will pick up in the new mode.
     */
    promoteToAuto(
      podId: string,
      targetOutput: 'pr' | 'branch' | 'artifact' | 'none',
      options?: { instructions?: string; skipAgent?: boolean },
    ): Promise<void> {
      return workspacePromotion.promoteToAuto(podId, targetOutput, options);
    },

    completeSession(
      podId: string,
      options?: {
        promoteTo?: 'pr' | 'branch' | 'artifact' | 'none';
        instructions?: string;
        skipAgent?: boolean;
      },
    ): Promise<{ pushError?: string; promotedTo?: 'pr' | 'branch' | 'artifact' | 'none' }> {
      return workspaceCompletion.completeSession.call(this, podId, options);
    },

    syncWorkspaceBranch(
      podId: string,
    ): Promise<{ committed: boolean; pushed: boolean; error?: string }> {
      return workspaceBranchSync.syncWorkspaceBranch(podId);
    },

    preserveWorkspace(podId: string, reason = 'operator recovery'): Promise<void> {
      return workspaceRecoveryCommands.preserveWorkspace(podId, reason);
    },

    quiesceSandboxAgent(podId: string): Promise<void> {
      return workspaceRecoveryCommands.quiesceSandboxAgent(podId);
    },

    suspendSandboxForRecovery(podId: string): Promise<void> {
      return workspaceRecoveryCommands.suspendSandboxForRecovery(podId);
    },

    cleanupPodResourcesForRecovery(podId: string): Promise<void> {
      return workspaceRecoveryCommands.cleanupPodResourcesForRecovery(podId);
    },
    assertCanRework(
      podId: string,
    ): ReturnType<PodFacadeOwners['continuationControls']['assertCanRework']> {
      return continuationControls.assertCanRework(podId);
    },
    triggerValidation(
      podId: string,
      options?: { force?: boolean; validationOnly?: boolean },
    ): Promise<void> {
      return validationTriggerWorkflow.triggerValidation.call(
        createValidationTriggerCalls(this),
        podId,
        options,
      );
    },
    revalidateSession(
      podId: string,
      options?: { force?: boolean },
    ): Promise<{ newCommits: boolean; result: 'pass' | 'fail' }> {
      return validationRevalidationWorkflow.revalidateSession.call(
        { approveSession: (...args) => this.approveSession(...args) },
        podId,
        options,
      );
    },

    fixManually(
      podId: string,
      actorOrUserId: OperatorActor | string,
      creator?: PodCreator,
      instructions?: string,
    ): Promise<Pod> {
      return workspaceManualFix.fixManually.call(this, podId, actorOrUserId, creator, instructions);
    },

    notifyEscalation(podId: string, escalation: EscalationRequest): void {
      operatorControls.notifyEscalation(podId, escalation);
    },

    touchHeartbeat,
    getReviewerConfig(pod: Pod): {
      profile: PodExecutionSettings;
      credentials: ProviderCredentials | null;
    } {
      return getEffectiveReviewerConfig(pod);
    },
    getReviewerExecEnv(pod: Pod): Promise<Record<string, string> | undefined> {
      return buildReviewerExecEnv(pod);
    },
    getReviewerExecutor,
    getProjectMemoryScope(pod: Pod): import('./project-memory-scope.js').ProjectMemoryScope {
      return admissionMemory.getProjectMemoryScope(pod);
    },
    getLaunchMemoryContext(pod: Pod): {
      profile: PodExecutionSettings;
      projectScope: import('./project-memory-scope.js').ProjectMemoryScope;
      reviewer: import('../providers/memory-reviewer.js').MemoryReviewer;
    } {
      return admissionMemory.getLaunchMemoryContext(pod);
    },

    deleteSession(podId: string): Promise<void> {
      return workspaceDeletion.deleteSession(podId);
    },

    startPreview(podId: string): Promise<{ previewUrl: string }> {
      return resourcePreviewControls.startPreview(podId);
    },

    stopPreview(podId: string): Promise<void> {
      return resourcePreviewControls.stopPreview(podId);
    },

    previewStatus(podId: string): Promise<{
      running: boolean;
      reachable: boolean;
      restartCount: number;
      lastError: string | null;
      previewUrl: string | null;
    }> {
      return resourcePreviewControls.previewStatus(podId);
    },

    getSession(podId: string): Pod {
      return admissionQueries.getSession(podId);
    },

    refreshReadinessAfterQualityScore(podId: string): boolean {
      return approvalControls.refreshReadinessAfterQualityScore(podId);
    },

    async getValidationEnvironment(podId: string): Promise<Record<string, string> | undefined> {
      const pod = podRepo.getOrThrow(podId);
      return validationEnvironmentForPod(pod, executionForPod(pod));
    },

    async getDeploymentConfiguration(podId: string): Promise<PodExecutionSettings['deployment']> {
      return admissionQueries.getDeploymentConfiguration(podId);
    },

    async getInjectedMcpServer(
      podId: string,
      name: string,
    ): Promise<InjectedMcpServer | undefined> {
      return admissionQueries.getInjectedMcpServer.call(this, podId, name);
    },

    getInjectedMcpServers(podId: string): InjectedMcpServer[] {
      return admissionQueries.getInjectedMcpServers(podId);
    },

    listSessions(filters?: {
      profileName?: string;
      status?: PodStatus | PodStatus[];
      userId?: string;
      limit?: number;
      since?: string;
      before?: { createdAt: string; id: string };
    }): Pod[] {
      return admissionQueries.listSessions(filters);
    },

    getSessionStats(filters?: { profileName?: string }): PodStats {
      return admissionQueries.getSessionStats(filters);
    },

    getSeriesPods(seriesId: string): Pod[] {
      return admissionQueries.getSeriesPods(seriesId);
    },

    rehydrateDependentSessions(): void {
      admissionDependents.rehydrateDependentSessions();
    },

    async deleteSeriesWithCascade(seriesId: string): Promise<void> {
      return admissionSeries.deleteSeriesWithCascade.call(this, seriesId);
    },

    getValidationHistory(podId: string): import('./validation-repository.js').StoredValidation[] {
      return admissionQueries.getValidationHistory(podId);
    },

    approveAllValidated(): Promise<{ approved: string[]; skipped: ApproveAllSkippedPod[] }> {
      return approvalControls.approveAllValidated.call(this);
    },

    killAllFailed(): Promise<{ killed: string[] }> {
      return operatorControls.killAllFailed.call(this);
    },
    extendAttempts(podId: string, additionalAttempts: number): Promise<void> {
      return validationWorkflowControls.extendAttempts.call(
        { triggerValidation: (...args) => this.triggerValidation(...args) },
        podId,
        additionalAttempts,
      );
    },
    applyOverridesInstant(podId: string): Promise<{ advanced: boolean }> {
      return validationWorkflowControls.applyOverridesInstant(podId);
    },

    approveFactWaiver(
      podId: string,
      factId: string,
      reason?: string,
      actor: OperatorActor = { type: 'automation', id: 'direct-pod-manager' },
    ): Promise<{ newCommits: boolean; result: 'pass' | 'fail' }> {
      return approvalControls.approveFactWaiver.call(this, podId, factId, reason, actor);
    },

    forceApprove(
      podId: string,
      reason?: string,
      actor: OperatorActor = { type: 'automation', id: 'direct-pod-manager' },
    ): Promise<void> {
      return approvalControls.forceApprove(podId, reason, actor);
    },

    extendPrAttempts(podId: string, additionalAttempts: number): Promise<void> {
      return fixControls.extendPrAttempts(podId, additionalAttempts);
    },
    interruptValidation(
      podId: string,
    ): ReturnType<PodFacadeOwners['validationWorkflowControls']['interruptValidation']> {
      return validationWorkflowControls.interruptValidation(podId);
    },
    updateFromBase(podId: string): Promise<UpdateFromBaseResponse> {
      return validationWorkflowControls.updateFromBase.call(
        { triggerValidation: (...args) => this.triggerValidation(...args) },
        podId,
      );
    },
    setSkipValidation(
      podId: string,
      skip: boolean,
      actor: OperatorActor = { type: 'automation', id: 'direct-pod-manager' },
    ): ReturnType<PodFacadeOwners['validationWorkflowControls']['setSkipValidation']> {
      return validationWorkflowControls.setSkipValidation(podId, skip, actor);
    },

    refreshNetworkPolicy(profileName: string): Promise<void> {
      return resourceNetwork.refreshNetworkPolicy(profileName);
    },

    injectCredential(_podId: string, _service: 'github' | 'ado'): Promise<void> {
      return operatorTools.injectCredential(_podId, _service);
    },

    installCliTool(podId: string, tool: 'gh' | 'az'): Promise<void> {
      return operatorTools.installCliTool(podId, tool);
    },

    /**
     * Thin wrapper over the queue-driven fix-pod model: validate the parent is
     * eligible, enqueue the feedback message, and let `maybeSpawnFixSession`
     * decide whether to spawn/recycle. The task itself is built from the
     * drained queue when the fix pod transitions to `running`.
     */
    spawnFixSession(podId: string, userMessage?: string): Promise<void> {
      return fixControls.spawnFixSession(podId, userMessage);
    },

    requestFixSession(podId: string, message: string): Promise<SpawnFixResponse> {
      return fixControls.requestFixSession(podId, message);
    },

    retryCreatePr(podId: string): Promise<void> {
      return retryCreatePr(podId);
    },

    getArtifactResumeObservation(podId: string): ArtifactResumeObservation {
      return workspaceArtifactObservation.getArtifactResumeObservation(podId);
    },
    resumePod(podId: string): Promise<{
      action:
        | 'retry-pr'
        | 'revalidate'
        | 'retry-fix-delivery'
        | 'retry-agent'
        | 'collect-artifacts';
    }> {
      return continuationControls.resumePod.call(
        {
          handleCompletion: (...args) => this.handleCompletion(...args),
          revalidateSession: (...args) => this.revalidateSession(...args),
          approveSession: (...args) => this.approveSession(...args),
        },
        podId,
      );
    },
    continueProvider(
      podId: string,
      requestedTarget?: ProviderFailoverTarget | 'profile-primary',
      actor: OperatorActor = { type: 'automation', id: 'direct-pod-manager' },
    ): Promise<{ action: 'same-provider' | 'alternate-provider' | 'primary-provider' }> {
      return providerContinuation.continueProvider(podId, requestedTarget, actor);
    },

    forceComplete(
      podId: string,
      reason?: string,
      actor: OperatorActor = { type: 'automation', id: 'direct-pod-manager' },
    ): Promise<void> {
      return workspaceEscapeControls.forceComplete(podId, reason, actor);
    },

    kickPod(
      podId: string,
      reason?: string,
      actor: OperatorActor = { type: 'automation', id: 'direct-pod-manager' },
    ): Promise<{ action: 'requeued' | 'failed' }> {
      return workspaceEscapeControls.kickPod(podId, reason, actor);
    },

    startStuckPodWatchdog(options?: { intervalMs?: number; thresholdMs?: number }): void {
      workspaceWatchdog.startStuckPodWatchdog.call(this, options);
    },

    stopStuckPodWatchdog(): void {
      workspaceWatchdog.stopStuckPodWatchdog();
    },

    recoverWorktree(podId: string): Promise<{
      recovered: boolean;
      message: string;
      blockers?: Array<{ status: string; path: string }>;
    }> {
      return workspaceRecoveryCommands.recoverWorktree(podId);
    },
  };
}
