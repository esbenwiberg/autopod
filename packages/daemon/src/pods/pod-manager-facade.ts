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
import {
  recoveryError,
  type SandboxRecoveryRequest,
} from '../containers/sandbox-recovery-journal.js';
import type { PodExecutionSettings } from '../interfaces/pod-execution-settings.js';
import type { AgentRunOutcome } from './agent-execution-contracts.js';
import type { ApproveAllSkippedPod, ApproveSessionOptions } from './approval-contracts.js';
import { rewriteConfiguration } from './approval-source-rewrite.js';
import type { ArtifactResumeObservation } from './artifact-resume-observation.js';
import { createValidationTriggerCalls } from './pod-facade-calls.js';
import type { PodFacadeOwners } from './pod-facade-ports.js';
import type { PodStats } from './pod-repository.js';
import {
  type CheckpointOutcomeRequest,
  type CheckpointRecoveryRequest,
  checkpointError,
} from './retained-checkpoint-repository.js';
import type { SourceAdoptionRequest } from './source-adoption-controller.js';
import { sourceAdoptionError } from './source-adoption-identity.js';
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
    terminationReconciliation,
  } = captured;
  return {
    inspectArtifactChecksRecovery(podId: string) {
      return (
        captured.artifactChecksRecovery ?? checkpointError('Artifact checks unavailable')
      ).inspect(podId);
    },
    recoverArtifactChecks(
      podId: string,
      input: import('@autopod/shared').ArtifactChecksRecoveryRequest,
      actor: OperatorActor,
      reconcile = false,
    ) {
      return (
        captured.artifactChecksRecovery ?? checkpointError('Artifact checks unavailable')
      ).submit(podId, input, actor, reconcile);
    },
    inspectRecoveryFork(podId: string) {
      return (captured.recoveryFork ?? checkpointError('Recovery fork unavailable')).inspect(podId);
    },
    previewRecoveryFork(podId: string, input: import('@autopod/shared').RecoveryForkInput) {
      return (captured.recoveryFork ?? checkpointError('Recovery fork unavailable')).preview(
        podId,
        input,
      );
    },
    createRecoveryFork(
      podId: string,
      input: import('@autopod/shared').RecoveryForkRequest,
      actor: OperatorActor,
    ) {
      return (captured.recoveryFork ?? checkpointError('Recovery fork unavailable')).create(
        podId,
        input,
        actor,
      );
    },
    getRecoveryFork(podId: string, requestId: string) {
      return (captured.recoveryFork ?? checkpointError('Recovery fork unavailable')).get(
        podId,
        requestId,
      );
    },
    inspectStalledWorkerRecovery(podId: string) {
      return (
        captured.stalledWorkerRecovery ?? checkpointError('Stalled recovery unavailable')
      ).inspectStalledWorkerRecovery(podId);
    },
    recoverStalledWorker(
      podId: string,
      request: import('@autopod/shared').StalledWorkerRecoveryRequest,
      actor: OperatorActor,
    ) {
      return (
        captured.stalledWorkerRecovery ?? checkpointError('Stalled recovery unavailable')
      ).recoverStalledWorker(podId, request, actor);
    },
    inspectRepairContinuation(podId: string) {
      return (captured.checkpointRecovery?.repair ?? checkpointError('Repair unavailable')).inspect(
        podId,
      );
    },
    previewRepairContinuation(
      podId: string,
      query: import('@autopod/shared').RepairContinuationPreviewQueryV1,
    ) {
      return (captured.checkpointRecovery?.repair ?? checkpointError('Repair unavailable')).preview(
        podId,
        query,
      );
    },
    authorizeRepairContinuation(
      podId: string,
      request: import('@autopod/shared').RepairContinuationRequestV1,
      actor: OperatorActor,
    ) {
      return (
        captured.checkpointRecovery?.repair ?? checkpointError('Repair unavailable')
      ).authorize(podId, request, actor);
    },
    getRepairContinuation(podId: string, requestId: string) {
      return (
        captured.checkpointRecovery?.repair ?? checkpointError('Repair unavailable')
      ).operation(podId, requestId);
    },
    inspectRetainedFinalization(podId: string) {
      return (
        captured.retainedFinalization ?? checkpointError('Retained finalization unavailable')
      ).inspectRetainedFinalization(podId);
    },
    finalizeRetained(
      podId: string,
      request: import('@autopod/shared').RetainedFinalizationRequest,
      actor: OperatorActor,
    ) {
      return (
        captured.retainedFinalization ?? checkpointError('Retained finalization unavailable')
      ).finalizeRetained(podId, request, actor);
    },
    acceptFindings: captured.acceptFindings,
    ...captured.validationExecutionRecovery,
    getRecoveryFiles(podId: string, includeOriginal = false) {
      return (captured.sandboxRecovery ?? recoveryError('File recovery unavailable')).files.inspect(
        podId,
        includeOriginal,
      );
    },
    readRecoveryFile(
      podId: string,
      selection: import('../interfaces/recovery-files.js').RecoveryFileSelection,
    ) {
      return (captured.sandboxRecovery ?? recoveryError('File recovery unavailable')).files.read(
        podId,
        selection,
      );
    },
    getSandboxRecovery(podId: string) {
      return (captured.sandboxRecovery ?? recoveryError('Sandbox recovery unavailable')).inspect(
        podId,
      );
    },
    recoverSandbox(podId: string, input: SandboxRecoveryRequest, actor: OperatorActor) {
      return (captured.sandboxRecovery ?? recoveryError('Sandbox recovery unavailable')).submit(
        podId,
        input,
        actor,
      );
    },
    prepareRewriteRepair(
      podId: string,
      input: import('@autopod/shared').ApprovalRewriteRepairRequest,
      actor: OperatorActor,
    ) {
      return (
        captured.checkpointRecovery ?? checkpointError('Rewrite repair unavailable')
      ).prepareRewriteRepair(podId, input, actor);
    },
    checkRewriteRepair(
      podId: string,
      recoveryId: string,
      input: import('@autopod/shared').ApprovalRewriteRepairCheckRequest,
      actor: OperatorActor,
    ) {
      return (
        captured.checkpointRecovery ?? checkpointError('Rewrite repair unavailable')
      ).checkRewriteRepair(podId, recoveryId, input, actor);
    },
    previewRetainedExecution(
      podId: string,
      profileId: string,
      buildOnlyEnvironmentKeys?: string[],
    ) {
      return (
        captured.checkpointRecovery ?? checkpointError('Retained continuation unavailable')
      ).previewExecution(podId, profileId, buildOnlyEnvironmentKeys);
    },
    recoverInfrastructure(
      podId: string,
      input: import('@autopod/shared').InfrastructureRecoveryRequest,
      actor: OperatorActor,
    ) {
      return (
        captured.checkpointRecovery ?? checkpointError('Recovery unavailable')
      ).recoverInfrastructure(podId, input, actor);
    },
    reconcileInfrastructure(
      podId: string,
      input: import('@autopod/shared').InfrastructureRecoveryRequest,
      actor: OperatorActor,
    ) {
      return (
        captured.checkpointRecovery ?? checkpointError('Recovery unavailable')
      ).reconcileInfrastructure(podId, input, actor);
    },
    continueRetained(
      podId: string,
      input: import('@autopod/shared').RetainedContinuationRequest,
      actor: OperatorActor,
    ) {
      return (
        captured.checkpointRecovery ?? checkpointError('Retained continuation unavailable')
      ).continueRetained(podId, input, actor);
    },
    checkRetainedCandidate(
      podId: string,
      recoveryId: string,
      input: import('@autopod/shared').RetainedContinuationCheckRequest,
      actor: OperatorActor,
    ) {
      return (
        captured.checkpointRecovery ?? checkpointError('Retained continuation unavailable')
      ).checkCandidate(podId, recoveryId, input, actor);
    },
    recoverCheckpoint(podId: string, input: CheckpointRecoveryRequest, actor: OperatorActor) {
      return (
        captured.checkpointRecovery ?? checkpointError('Checkpoint recovery unavailable')
      ).submit(podId, input, actor);
    },
    reconcileCheckpointOutcome(
      podId: string,
      recoveryId: string,
      input: CheckpointOutcomeRequest,
      actor: OperatorActor,
    ) {
      return (
        captured.checkpointRecovery ?? checkpointError('Checkpoint recovery unavailable')
      ).reconcileOutcome(podId, recoveryId, input, actor);
    },
    inspectRetainedContinuation(podId: string) {
      return (
        captured.checkpointRecovery ?? checkpointError('Retained continuation unavailable')
      ).inspect(podId);
    },
    getCheckpointRecoverySelection(podId: string) {
      return (
        captured.checkpointRecovery ?? checkpointError('Checkpoint recovery unavailable')
      ).selection(podId);
    },
    getCheckpointRecoveries(podId: string) {
      podRepo.getOrThrow(podId);
      return (
        captured.checkpointRecovery ?? checkpointError('Checkpoint recovery unavailable')
      ).list(podId);
    },
    adoptSource(podId: string, input: SourceAdoptionRequest, actor: OperatorActor) {
      return (captured.sourceAdoption ?? sourceAdoptionError('Source adoption unavailable')).submit(
        podId,
        input,
        actor,
      );
    },
    getApprovalSourceRewrite(
      podId: string,
    ): import('@autopod/shared').SourceAdoptionList['approvalRewrite'] {
      const pod = podRepo.getOrThrow(podId);
      const record = podRepo.approvalRewrites?.latest(pod);
      if (!record) return undefined;
      let checks: 'pending' | 'pass' | 'stale' = 'pending';
      if (record.checked) {
        try {
          const current = podRepo.approvalRewrites?.assertDelivery(pod);
          checks =
            current?.binding.configurationHash === rewriteConfiguration(pod, executionForPod(pod))
              ? 'pass'
              : 'stale';
        } catch {
          checks = 'stale';
        }
      }
      const repair = podRepo.retainedCheckpoints?.latest(podId);
      const held =
        ['failed', 'review_required'].includes(pod.status) ||
        Boolean(pod.lastRecoveryTrigger && pod.lastCorrectionMessage?.includes(record.id));
      return {
        id: record.id,
        generation: record.activated?.generation ?? record.generation,
        phase: record.checked
          ? 'checked'
          : record.activated
            ? held
              ? 'checks-held'
              : 'checking'
            : record.prepared
              ? 'prepared'
              : 'preparing',
        predecessorHeadSha: record.binding.predecessor.commitSha,
        candidateHeadSha: record.checked?.head ?? record.prepared?.head,
        checks,
        originalResources: 'retained',
        requiresHumanApproval: true,
        ...(repair?.binding.approvalRewrite?.id === record.id
          ? {
              repair: {
                id: repair.id,
                failedDispatchId: repair.binding.approvalRewrite.dispatchId,
                phase:
                  repair.blocked ||
                  repair.checked?.result.overall === 'fail' ||
                  (repair.activated && held)
                    ? ('held' as const)
                    : repair.checked
                      ? ('checked' as const)
                      : repair.activated
                        ? ('checking' as const)
                        : repair.prepared
                          ? ('prepared' as const)
                          : ('preparing' as const),
              },
            }
          : {}),
      };
    },
    getSourceAdoptions(podId: string) {
      podRepo.getOrThrow(podId);
      return (captured.sourceAdoption ?? sourceAdoptionError('Source adoption unavailable')).list(
        podId,
      );
    },
    getLaunchConfiguration(podId: string): EffectiveLaunchConfig | null {
      return admissionQueries.getLaunchConfiguration(podId);
    },
    prepareResolvedSession(
      config: EffectiveLaunchConfig,
      userId: string,
      creator?: PodCreator,
      actor?: OperatorActor,
    ): Promise<() => Pod> {
      return admissionResolved.prepareResolvedSession(config, userId, creator, actor);
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
      const run = () => processWorkflow.processPod.call(this, podId);
      const checkpointRun = () =>
        captured.checkpointRecovery ? captured.checkpointRecovery.process(podId, run) : run();
      return captured.recoveryFork
        ? captured.recoveryFork.process(podId, checkpointRun)
        : checkpointRun();
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

    reconcileInfrastructureBlocker(podId: string): Promise<void> {
      return completionWorkflow.reconcileInfrastructureBlocker(podId);
    },

    sendMessage(
      podId: string,
      message: string,
      actor: OperatorActor = { type: 'automation', id: 'direct-pod-manager' },
    ): Promise<void> {
      if (captured.podRepo.retainedCoding?.latest(podId))
        return (
          captured.checkpointRecovery ?? checkpointError('Coding reply unavailable')
        ).replyToCoding(podId, actor, () =>
          operatorMessages.sendMessage.call(this, podId, message, actor),
        );
      if (
        captured.podRepo.retainedCheckpoints?.latest(podId)?.binding.continuation?.infrastructure
          ?.mode === 'rework'
      )
        return (
          captured.checkpointRecovery ?? checkpointError('Recovery unavailable')
        ).replyToRepair(podId, actor, () =>
          operatorMessages.sendMessage.call(this, podId, message, actor),
        );
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
    assertCanRetryValidation(podId: string): void {
      continuationControls.assertCanRetryValidation(podId);
    },
    assertCanRework(
      podId: string,
    ): ReturnType<PodFacadeOwners['continuationControls']['assertCanRework']> {
      return continuationControls.assertCanRework(podId);
    },
    triggerValidation(
      podId: string,
      options?: {
        force?: boolean;
        validationOnly?: boolean;
        onReworkQueued?: (generation: number) => void;
      },
    ): Promise<void> {
      return validationTriggerWorkflow.triggerValidation.call(
        createValidationTriggerCalls(this),
        podId,
        options,
      );
    },
    revalidateSession(
      podId: string,
      options?: { force?: boolean; checksOnly?: boolean },
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
    getReviewerConfig(
      pod: Pod,
      role?: 'reviewer' | 'advisor',
    ): {
      profile: PodExecutionSettings;
      credentials: ProviderCredentials | null;
    } {
      return getEffectiveReviewerConfig(pod, role);
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
    getExternalDelivery(podId: string) {
      return admissionQueries.getExternalDelivery(podId);
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
    reconcileTermination(podId: string, runId: string, reason: string, actor: OperatorActor) {
      return terminationReconciliation.reconcileTermination(podId, runId, reason, actor);
    },
    resumePod(
      podId: string,
      options?: { backgroundValidation?: boolean },
    ): Promise<{
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
        options,
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
