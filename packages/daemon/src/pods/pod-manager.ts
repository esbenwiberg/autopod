import { createProvisioningMaterials } from './provisioning-materials.js';
import { buildCodeIntelligenceServers } from './provisioning-runtime-files.js';
import { createProvisioningSandboxState } from './provisioning-sandbox-state.js';
import { createProvisioningToolInstallation } from './provisioning-tool-installation.js';
import { createProvisioningWorkflow } from './provisioning-workflow.js';
export {
  AGENT_SHIM_PATH,
  AGENT_ENV_PATH,
  AGENT_SHIM_SCRIPT,
} from './provisioning-runtime-files.js';
import { execFile } from 'node:child_process';

import { promisify } from 'node:util';

import { createContinuationContext } from './continuation-context.js';
import { createContinuationControls } from './continuation-controls.js';
import { buildManualReworkReason } from './continuation-policy.js';
import { createProviderAttemptContext } from './provider-attempt-context.js';
import { resolvedReasoningEffort } from './provider-attempt-policy.js';
import { createProviderContinuation } from './provider-continuation.js';
import { createValidationRevalidationWorkflow } from './validation-revalidation-workflow.js';
import { createValidationTriggerWorkflow } from './validation-trigger-workflow.js';
import { createValidationWorkflowControls } from './validation-workflow-controls.js';
import {
  assertProtectedOperationalPathsInScope,
  getPodValidationSkipPhases,
  getPodValidationSuite,
  loadCodeReviewSkill,
  makeUnexpectedValidationFailureResult,
} from './validation-workflow-policy.js';
import { createValidationWorkflowState } from './validation-workflow-state.js';

import { createAdvisoryValidation } from './advisory-validation.js';

import { createArtifactFinalizer } from './artifact-finalizer.js';

import { createReviewerContext } from './reviewer-context.js';

import { createRuntimeResumeContext } from './runtime-resume-context.js';

import { createValidationAttemptStart } from './validation-attempt-start.js';
import { createValidationEnvironment } from './validation-environment.js';
import { createValidationEvidence } from './validation-evidence.js';
import { createValidationExecution } from './validation-execution.js';
import {
  createValidationInfrastructure,
  isReviewInfrastructureOnlyFailure,
  reviewInfrastructureFailureLabel,
  validationInfrastructureFailureLabel,
} from './validation-infrastructure.js';
import { createValidationInputs } from './validation-inputs.js';

import { createValidationProgress } from './validation-progress.js';
import { createValidationProvenance } from './validation-provenance.js';
import { createValidationPublication } from './validation-publication.js';

import { createValidationWorkspace } from './validation-workspace.js';
import { createWorkerRuntimeCredentials } from './worker-runtime-credentials.js';

import { createWorkspacePreservation } from './workspace-preservation.js';

import { createAgentActivity } from './agent-activity.js';
import { createAgentEventConsumption } from './agent-event-consumption.js';

import { createAgentProcessWorkflow } from './agent-process-workflow.js';
import { createAgentRunRegistry } from './agent-run-registry.js';

import { createApprovalControls } from './approval-controls.js';
import { createApprovalDeliveryExecution } from './approval-delivery-execution.js';
import { createApprovalDeliveryPreparation } from './approval-delivery-preparation.js';
import { actorLabel, buildValidationWaiver, legacyRespondedBy } from './approval-policy.js';
import { createApprovalReadiness, createReadinessRefresh } from './approval-readiness.js';
import { createApprovalWorkflow } from './approval-workflow.js';
import {
  formatElapsedDuration,
  operatorErrorMessage,
  sanitizeFailureReason,
  summarizeAgentCompletionBlocker,
} from './completion-diagnostics.js';

import { createCompletionDiagnostics } from './completion-diagnostics.js';
import { createCompletionEvents } from './completion-events.js';
import { createCompletionGuards } from './completion-guards.js';
import { createCompletionOwners, createCompletionWorkflow } from './completion-workflow.js';
import { createDeliveryCredentials } from './delivery-credentials.js';
import {
  formatRebaseConflictReason,
  isSinglePrSeriesPod,
  resolvePrBaseBranch,
} from './delivery-policy.js';
import { createDeliveryPolling } from './delivery-polling.js';
import { createDeliveryPr } from './delivery-pr.js';
import { createDeliveryScan } from './delivery-scan.js';
import {
  createDeliveryMergeQueue,
  createDeliveryPollingState,
  createDeliveryProvider,
} from './delivery-state.js';
import {
  buildActionableFailureSummary,
  buildPrFixTask,
  createFixCyclePolicy,
} from './fix-policy.js';
import { createRevalidationPassDelivery } from './revalidation-pass-delivery.js';
import { createValidationPassDelivery } from './validation-pass-delivery.js';
import { createWorkspaceTransfer } from './workspace-transfer.js';
export { buildPrFixTask, buildActionableFailureSummary } from './fix-policy.js';
import { createFixAdmission } from './fix-admission.js';
import { createFixControls } from './fix-controls.js';
import { createFixDelivery } from './fix-delivery.js';
import { createFixFeedback } from './fix-feedback.js';
import { createFixParking } from './fix-parking.js';
import { createFixProviderBinding } from './fix-provider-binding.js';

import { createOperatorControls } from './operator-controls.js';
import { createOperatorKill } from './operator-kill.js';
import { createOperatorMessages } from './operator-messages.js';
import { createOperatorPause } from './operator-pause.js';
import { createOperatorRejection } from './operator-rejection.js';
import { createOperatorPauseState } from './operator-state.js';
import { createOperatorTools } from './operator-tools.js';

import {
  CONTAINER_APP_PORT,
  CONTAINER_CLEANUP_TIMEOUT_MS,
  allocateHostPort,
  hostnameFromUrl,
  portFromUrl,
} from './resource-policy.js';
export type { NetworkManager } from './resource-contracts.js';
import { createResourceAdvisoryCleanup, createResourceAdvisoryState } from './resource-advisory.js';
import { createResourceAuxiliary } from './resource-auxiliary.js';
import { createResourceCleanup } from './resource-cleanup.js';
import {
  createResourceCommitPolling,
  createResourceCommitPollingState,
} from './resource-commit-polling.js';
import { createResourceDenials } from './resource-denials.js';
import { createResourceNetwork } from './resource-network.js';
import { createResourcePreviewControls } from './resource-preview-controls.js';
import { createResourcePreviewTimers } from './resource-preview-timers.js';
import { createResourcePreview } from './resource-preview.js';

export type { PodCreator } from './workspace-contracts.js';
import { mergeOverrides, warnIfSinglePrSeriesMissingSeriesMeta } from './admission-policy.js';
import { createWorkspaceArtifactObservation } from './workspace-artifact-observation.js';
import { createWorkspaceBranchSource } from './workspace-branch-source.js';
import { createWorkspaceBranchSync } from './workspace-branch-sync.js';
import { createWorkspaceCompletion } from './workspace-completion.js';
import { createWorkspaceDeletion } from './workspace-deletion.js';
import { createWorkspaceEscapeControls } from './workspace-escape-controls.js';
import { createWorkspaceFences } from './workspace-fences.js';
import { createWorkspaceHostFetchRetry } from './workspace-host-fetch-retry.js';
import { createWorkspaceInfrastructureRecovery } from './workspace-infrastructure-recovery.js';
import { createWorkspaceManualFix } from './workspace-manual-fix.js';
import { createWorkspacePreservationRecovery } from './workspace-preservation-recovery.js';
import { createWorkspacePromotion } from './workspace-promotion.js';
import { createWorkspaceRecoveryCommands } from './workspace-recovery-commands.js';
import {
  createWorkspaceLeaseState,
  createWorkspaceRecoveryState,
} from './workspace-recovery-state.js';
import { createWorkspaceWatchdog } from './workspace-watchdog.js';
export { selectMemoryBriefingForPod } from './admission-memory-briefing.js';
import { createAdmissionAnalysisWorkspaces } from './admission-analysis-workspaces.js';
import { createAdmissionDependents } from './admission-dependents.js';
import { createAdmissionExecutionContext } from './admission-execution-context.js';
import { createAdmissionLegacy } from './admission-legacy.js';
import { createAdmissionMemoryContext } from './admission-memory-context.js';
import { createAdmissionQueries } from './admission-queries.js';
import { createAdmissionResolved } from './admission-resolved.js';
import { createAdmissionSeriesDeletion } from './admission-series-deletion.js';
import type { PodManager, PodManagerDependencies } from './pod-manager-contracts.js';
export type {
  ContainerManagerFactory,
  PodManager,
  PodManagerDependencies,
} from './pod-manager-contracts.js';
import { createPodManagerFacade } from './pod-manager-facade.js';
import { createTerminationReconciliation } from './termination-reconciliation.js';

export type { ApproveSessionOptions, ApproveAllSkippedPod } from './approval-contracts.js';

const execFileAsync = promisify(execFile);

export type { AgentRunOutcome } from './agent-execution-contracts.js';

export function createPodManager(deps: PodManagerDependencies): PodManager {
  const {
    podRepo,
    escalationRepo,
    nudgeRepo,
    fixFeedbackRepo,
    profileStore,
    providerAccountStore,
    providerCatalog,
    eventBus,
    containerManagerFactory,
    worktreeManager,
    runtimeRegistry,
    validationEngine,
    networkManager,
    sidecarManager,
    prManagerFactory: rawPrManagerFactory,
    enqueueSession,
    clearStuckQueueEntry,
    mcpBaseUrl,
    daemonConfig,
    logger,
    validationRepo,
    progressEventRepo,
    repoScanner,
    scanRepo,
    screenshotStore,
    hostScreenshotDir,
    safetyEventsRepo,
    qualityScoreRepo,
  } = deps;
  const { assertExecutionTerminationVerified, assertGuidanceCollected, ownsLifecycle } =
    createCompletionGuards({ podRepo, nudgeRepo });
  const admissionDependents = createAdmissionDependents({
    podRepo,
    logger,
    eventBus,
    enqueueSession,
  });
  const { maybeTriggerDependents } = admissionDependents;

  const { materializeSpecFiles, captureDeployBaselineHashes } =
    createProvisioningMaterials(execFileAsync);
  const {
    assertSandboxAgentStreamingExecSupported,
    syncSandboxRuntimeSessionState,
    syncSandboxSeriesHandover,
  } = createProvisioningSandboxState(deps, { podRepo, containerManagerFactory, logger });
  const { installGhBinary, installAzViaPip } = createProvisioningToolInstallation({ logger });
  const { executionForPod, executionCredentialsFor, injectionsForPod, resolveGitCredential } =
    createAdmissionExecutionContext(deps, { profileStore, daemonConfig });

  const { validationEnvironmentForPod } = createValidationEnvironment(deps, {
    executionCredentialsFor,
    containerManagerFactory,
  });
  const { prManagerFactory } = createDeliveryProvider(rawPrManagerFactory, podRepo);
  const { scheduleHostFetchRetry } = createWorkspaceHostFetchRetry({
    podRepo,
    enqueueSession,
    emitActivityStatus: (podId, message) => emitActivityStatus(podId, message),
  });

  const { primeRuntimeForResume } = createRuntimeResumeContext(deps, {
    executionForPod,
    executionCredentialsFor,
    injectionsForPod,
    mcpBaseUrl,
    buildCodeIntelligenceServers,
    resolvedReasoningEffort,
  });
  const { mergeQueue } = createDeliveryMergeQueue();
  const { startHaproxyDenyReceiver, stopHaproxyDenyReceiver } = createResourceDenials({
    containerManagerFactory,
    eventBus,
    logger,
  });

  const { readinessService, refreshReadiness } = createReadinessRefresh(deps, {
    podRepo,
    validationRepo,
    scanRepo,
    escalationRepo,
    qualityScoreRepo,
    logger,
  });
  const resourceNetwork = createResourceNetwork(deps, {
    networkManager,
    logger,
    profileStore,
    podRepo,
    daemonConfig,
    sidecarManager,
    providerAccountStore,
    providerCatalog,
    mcpBaseUrl,
    containerManagerFactory,
  });
  const { destroyPodNetwork } = resourceNetwork;

  const { ensureSandboxPreviewProxy, stopSandboxPreviewProxy } = createResourcePreview({
    containerManagerFactory,
    logger,
    podRepo,
  });

  const { killSidecarsForPod, cleanupTestRunBranches } = createResourceAuxiliary(deps, {
    sidecarManager,
    podRepo,
    logger,
    executionForPod,
  });

  const { clearPreviewTimer, schedulePreviewAutoStop } = createResourcePreviewTimers({
    stopSandboxPreviewProxy,
    containerManagerFactory,
    logger,
  });

  const { commitPolling } = createResourceCommitPollingState({ logger });

  const { mergePolling, DEFAULT_MERGE_POLL_INTERVAL_MS } = createDeliveryPollingState(logger);

  /** Active AbortControllers for in-progress validation runs, keyed by podId. */
  const { validationAbortControllers, attemptExtensionRuns, pendingUpdateFromBaseIntents } =
    createValidationWorkflowState();
  const {
    infrastructureResumeRuns,
    artifactResumeRuns,
    artifactCompletionRuns,
    coordinateInteractiveCompletion,
  } = createWorkspaceRecoveryState();

  const { pauseIntents } = createOperatorPauseState();

  const { activeAgentRuns, activeAgentRunResolvers } = createAgentRunRegistry();
  const {
    providerForAttempt,
    ensureProviderAttempt,
    rotateProviderAttemptForFreshSegment,
    closeProviderAttempt,
    isCompatibleTarget,
    selectProviderFailoverTarget,
    escapeProviderTargetDiagnosticValue,
    describeProviderFailoverTarget,
    providerFailoverUnavailableActivity,
    profileForProviderTarget,
    resolveEffectiveBoundProfile,
    openProviderTargetAttempt,
    rememberMaxCredentialLineage,
    forgetMaxCredentialLineage,
    maxCredentialLineageByPod,
  } = createProviderAttemptContext(deps, {
    podRepo,
    providerAccountStore,
    providerCatalog,
    profileStore,
    executionForPod,
    activeAgentRuns,
  });
  const { cleanupContainer } = createResourceCleanup(deps, {
    podRepo,
    logger,
    ownsLifecycle,
    stopSandboxPreviewProxy,
    stopHaproxyDenyReceiver,
    containerManagerFactory,
    forgetMaxCredentialLineage,
  });
  const { acquireAdvisoryQaSlot, releaseAdvisoryQaSlot, advisoryRuns } =
    createResourceAdvisoryState();
  const { forceWithLeaseAllowances } = createWorkspaceLeaseState();

  const { lastEventWriteAt, bumpActivityTimestamp, touchHeartbeat, recordNotReportedMemoryUsage } =
    createAgentActivity(deps, { podRepo, logger });
  const { emitActivityStatus, emitActivityError, transition, emitPodCompletedEvent } =
    createCompletionEvents({
      eventBus,
      bumpActivityTimestamp,
      recordNotReportedMemoryUsage,
      podRepo,
      refreshReadiness,
    });
  const { hasDurableAgentExecutionEvidence, tryRecoverTransientSandboxFailure } =
    createWorkspaceInfrastructureRecovery(deps, {
      ownsLifecycle,
      podRepo,
      emitActivityStatus,
      containerManagerFactory,
      logger,
      closeProviderAttempt,
      killSidecarsForPod,
      destroyPodNetwork,
    });

  const { cleanupContainerAfterAdvisorySettles } = createResourceAdvisoryCleanup({
    assertGuidanceCollected,
    advisoryRuns,
    cleanupContainer,
    emitActivityStatus,
    logger,
  });

  const { resolveApprovalReadiness, persistReadinessApproval, assertApprovalCurrent } =
    createApprovalReadiness({
      assertGuidanceCollected,
      advisoryRuns,
      readinessService,
      emitActivityStatus,
      isSinglePrSeriesPod,
      podRepo,
      eventBus,
      assertExecutionTerminationVerified,
    });
  const {
    handleDeletionGuardError,
    ownsArtifactCompletion,
    failInteractivePreservation,
    failBranchPreservation,
    assertInteractiveCompletionCurrent,
    parkOnWorktreeSyncFailure,
  } = createWorkspaceFences({
    podRepo,
    logger,
    eventBus,
    emitActivityStatus,
    nudgeRepo,
    emitActivityError,
    assertApprovalCurrent,
    assertGuidanceCollected,
    transition,
  });

  const { emitBlockingSecurityScanFindings } = createCompletionDiagnostics({ emitActivityError });
  const { runPushCheckpointScan, getLatestPushFindings } = createDeliveryScan({
    repoScanner,
    emitActivityStatus,
    logger,
    emitBlockingSecurityScanFindings,
    scanRepo,
  });

  const { parkOnCredentialFailure } = createDeliveryCredentials({
    podRepo,
    escalationRepo,
    transition,
    emitActivityStatus,
    logger,
  });

  const { ensurePrBaseBranchOnOrigin, pushAndCreatePr, retryCreatePr } = createDeliveryPr({
    worktreeManager,
    logger,
    resolveGitCredential,
    emitActivityStatus,
    assertGuidanceCollected,
    executionForPod,
    prManagerFactory,
    handleDeletionGuardError,
    getLatestPushFindings,
    podRepo,
  });
  const workspaceWatchdog = createWorkspaceWatchdog(deps, {
    logger,
    podRepo,
    stopSandboxPreviewProxy,
    containerManagerFactory,
    transition,
    emitActivityStatus,
    eventBus,
    enqueueSession,
    validationRepo,
  });

  const { resolveBranchSource } = createWorkspaceBranchSource({ podRepo, logger });

  const { isFixCycleTerminal, isFixPodRecyclable } = createFixCyclePolicy();

  const { providerBindingForFixPod } = createFixProviderBinding(deps);

  const { parkFixPodDeliveryFailure, isParkedHostPushRecovery, isRetryableFixDeliveryFailure } =
    createFixParking({ parkOnCredentialFailure, logger, emitActivityStatus, transition });

  const { maybeSpawnFixSession } = createFixAdmission(deps, {
    podRepo,
    logger,
    isFixCycleTerminal,
    emitActivityStatus,
    isFixPodRecyclable,
    transition,
    stopMergePolling: (podId) => stopMergePolling(podId),
    executionForPod,
    resolveBranchSource,
    cleanupContainer,
    providerBindingForFixPod,
    enqueueSession,
    eventBus,
  });

  const { postFixPodReviewFeedbackReplies } = createFixFeedback({
    executionForPod,
    prManagerFactory,
    logger,
    emitActivityStatus,
  });

  const { completeFixPodAfterPush } = createFixDelivery({
    assertGuidanceCollected,
    executionForPod,
    podRepo,
    logger,
    emitActivityStatus,
    mergeQueue,
    worktreeManager,
    resolveGitCredential,
    parkFixPodDeliveryFailure,
    postFixPodReviewFeedbackReplies,
    cleanupContainer,
    transition,
    eventBus,
  });

  const validationWorkflowControls = createValidationWorkflowControls(deps, {
    actorLabel,
    legacyRespondedBy,
    buildValidationWaiver,
    mergeOverrides,
    podRepo,
    escalationRepo,
    nudgeRepo,
    worktreeManager,
    logger,
    executionForPod,
    assertExecutionTerminationVerified,
    resolveGitCredential,
    validationAbortControllers,
    attemptExtensionRuns,
    pendingUpdateFromBaseIntents,
    forceWithLeaseAllowances,
    emitActivityStatus,
    transition,
    maybeTriggerDependents,
  });
  const { runUpdateFromBaseAfterAbort, applySkipValidationDecision, claimValidation } =
    validationWorkflowControls;
  const { startMergePolling, stopMergePolling, resumeMergePolling } = createDeliveryPolling({
    podRepo,
    assertApprovalCurrent,
    executionForPod,
    prManagerFactory,
    transition,
    emitActivityStatus,
    worktreeManager,
    mergeQueue,
    cleanupContainer,
    eventBus,
    logger,
    maybeTriggerDependents,
    buildActionableFailureSummary,
    fixFeedbackRepo,
    maybeSpawnFixSession,
    DEFAULT_MERGE_POLL_INTERVAL_MS,
    mergePolling,
  });

  // Resume merge polling on startup
  resumeMergePolling();
  const { startCommitPolling, stopCommitPolling } = createResourceCommitPolling(deps, {
    podRepo,
    commitPolling,
    containerManagerFactory,
    logger,
    emitActivityStatus,
  });

  const { getResumeEnv, persistRuntimeCredentialsForPod } = createWorkerRuntimeCredentials(deps, {
    podRepo,
    providerAccountStore,
    providerCatalog,
    profileStore,
    containerManagerFactory,
    logger,
    maxCredentialLineageByPod,
    resolveEffectiveBoundProfile,
    validationEnvironmentForPod,
    rememberMaxCredentialLineage,
  });

  const { buildReviewerExecEnv, getEffectiveReviewerConfig, getReviewerExecutor } =
    createReviewerContext(deps, {
      providerAccountStore,
      providerCatalog,
      profileStore,
      containerManagerFactory,
      logger,
      maxCredentialLineageByPod,
      executionForPod,
      resolveEffectiveBoundProfile,
    });
  const admissionMemory = createAdmissionMemoryContext(deps, {
    getReviewerExecutor,
    getEffectiveReviewerConfig,
  });

  const { syncWorkspaceBack, recoverWorktreeFromContainer } = createWorkspaceTransfer({ logger });

  const continuationContext = createContinuationContext(deps, {
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
  });
  const {
    appendDecisionContext,
    buildRecoveryTask,
    buildContinuationPrompt,
    buildReworkTask,
    recordContinuationProvenance,
    beginGoalTaskRework,
    taskFeedbackEvents,
  } = continuationContext;

  const providerContinuation = createProviderContinuation(deps, {
    podRepo,
    profileStore,
    providerAccountStore,
    containerManagerFactory,
    worktreeManager,
    runtimeRegistry,
    enqueueSession,
    logger,
    executionForPod,
    assertExecutionTerminationVerified,
    stopHaproxyDenyReceiver,
    CONTAINER_CLEANUP_TIMEOUT_MS,
    stopSandboxPreviewProxy,
    closeProviderAttempt,
    selectProviderFailoverTarget,
    providerFailoverUnavailableActivity,
    profileForProviderTarget,
    openProviderTargetAttempt,
    forgetMaxCredentialLineage,
    syncWorkspaceBack,
    emitActivityStatus,
    operatorErrorMessage,
    transition,
  });
  const {
    visibleProviderHandoffActivity,
    prepareProviderContinuationHandoff,
    queueProviderContinuation,
    handleProviderLimit,
  } = providerContinuation;

  const continuationControls = createContinuationControls(deps, {
    podRepo,
    containerManagerFactory,
    enqueueSession,
    logger,
    assertExecutionTerminationVerified,
    assertGuidanceCollected,
    hasDurableAgentExecutionEvidence,
    infrastructureResumeRuns,
    artifactResumeRuns,
    activeAgentRuns,
    resolveEffectiveBoundProfile,
    ownsLifecycle,
    isRetryableFixDeliveryFailure,
    completeFixPodAfterPush,
    emitActivityStatus,
    pushAndCreatePr,
    transition,
  });

  const { prepareWorkspaceForValidation } = createValidationWorkspace({
    logger,
    syncWorkspaceBack,
  });

  const { preservePodWorkspace, checkpointSandboxWorkspaceForPod } = createWorkspacePreservation({
    getContainerManager: (target) => containerManagerFactory.get(target),
    syncWorkspaceBack,
    workspaceCheckpointController: deps.workspaceCheckpointController,
    sandboxWorkspaceCheckpoint: deps.sandboxWorkspaceCheckpoint,
    logger,
    emitActivityStatus,
  });
  const { preserveSandboxAfterAgentFailure, tryRecoverAfterWorkspaceSyncFailure } =
    createWorkspacePreservationRecovery({
      podRepo,
      preservePodWorkspace,
      cleanupContainer,
      emitActivityStatus,
      logger,
      containerManagerFactory,
      recoverWorktreeFromContainer,
    });

  const { holdCompletionForHumanWork, prepareSourceForCompletion, applyCompletionDecision } =
    createCompletionOwners({
      podRepo,
      nudgeRepo,
      preservePodWorkspace,
      ownsArtifactCompletion,
      transition,
      logger,
      emitActivityStatus,
      containerManagerFactory,
      worktreeManager,
      checkpointSandboxWorkspaceForPod,
      syncSandboxSeriesHandover,
      syncWorkspaceBack,
      tryRecoverAfterWorkspaceSyncFailure,
      recoverWorktreeFromContainer,
      parkOnWorktreeSyncFailure,
      handleDeletionGuardError,
      executionForPod,
      cleanupContainer,
      emitPodCompletedEvent,
      maybeTriggerDependents,
    });

  const { startValidationAttempt } = createValidationAttemptStart({
    assertGuidanceCollected,
    runPushCheckpointScan,
    podRepo,
    transition,
    eventBus,
    getPodValidationSuite,
    emitActivityStatus,
  });

  const { prepareValidationInputs } = createValidationInputs({
    logger,
    worktreeManager,
    podRepo,
    validationRepo,
    overrideSource: deps,
    validationEnvironmentForPod,
    assertProtectedOperationalPathsInScope,
    loadCodeReviewSkill,
    getEffectiveReviewerConfig,
    buildReviewerExecEnv,
    mergeOverrides,
    getReviewerExecutor,
    getPodValidationSkipPhases,
    emitActivityStatus,
  });

  const { buildPhaseEventCallbacks, ownedValidationCallbacks } = createValidationProgress({
    eventBus,
  });

  const { recordValidationProvenance, withReviewerLaunchPreflight } = createValidationProvenance({
    podRepo,
    containerManagerFactory,
    resolveEffectiveBoundProfile,
  });

  const { validateWithInfrastructureRetries } = createValidationExecution({
    logger,
    containerManagerFactory,
    podRepo,
    validationEngine,
    retrySource: deps,
    recordValidationProvenance,
    resolveEffectiveBoundProfile,
    withReviewerLaunchPreflight,
    ownedValidationCallbacks,
    emitActivityStatus,
    makeUnexpectedValidationFailureResult,
    validationInfrastructureFailureLabel,
    isReviewInfrastructureOnlyFailure,
    reviewInfrastructureFailureLabel,
  });

  const { collectValidationEvidence } = createValidationEvidence({
    logger,
    containerManagerFactory,
    checkpointSandboxWorkspaceForPod,
    syncWorkspaceBack,
    screenshotStore,
    hostScreenshotDir,
    emitActivityStatus,
    formatElapsedDuration,
  });

  const { publishValidationResult } = createValidationPublication({
    podRepo,
    validationRepo,
    eventBus,
  });

  const {
    parkOnRetryAdmission,
    parkOnValidationInfrastructureFailure,
    parkOnReviewInfrastructureFailure,
  } = createValidationInfrastructure({
    logger,
    podRepo,
    containerManagerFactory,
    transition,
    stopSandboxPreviewProxy,
    emitActivityStatus,
  });

  const { advisoryPublicationOwnership, runAdvisoryAfterValidation } = createAdvisoryValidation({
    podRepo,
    nudgeRepo,
    validationRepo,
    validationEngine,
    logger,
    advisoryRuns,
    acquireAdvisoryQaSlot,
    releaseAdvisoryQaSlot,
    buildPhaseEventCallbacks,
    ownedValidationCallbacks,
    refreshReadiness,
    emitActivityStatus,
  });

  const { preserveArtifacts, finalizeArtifactPod } = createArtifactFinalizer({
    podRepo,
    getContainerManager: (target) => containerManagerFactory.get(target),
    ownsArtifactCompletion,
    executionForPod,
    syncSandboxSeriesHandover,
    resolveGitCredential,
    worktreeManager,
    cleanupContainer,
    transition,
    logger,
    emitActivityStatus,
    emitActivityError,
  });
  const { completeValidationPass } = createValidationPassDelivery({
    warnIfSinglePrSeriesMissingSeriesMeta,
    resolvePrBaseBranch,
    podRepo,
    containerManagerFactory,
    worktreeManager,
    validationEngine,
    logger,
    prManagerFactory,
    resolveGitCredential,
    refreshReadiness,
    getLatestPushFindings,
    stopSandboxPreviewProxy,
    pendingUpdateFromBaseIntents,
    completeFixPodAfterPush,
    emitActivityStatus,
    advisoryPublicationOwnership,
    runAdvisoryAfterValidation,
    parkOnCredentialFailure,
    handleDeletionGuardError,
    ensurePrBaseBranchOnOrigin,
    transition,
    maybeTriggerDependents,
  });
  const validationTriggerWorkflow = createValidationTriggerWorkflow(deps, {
    buildManualReworkReason,
    mergeOverrides,
    podRepo,
    escalationRepo,
    eventBus,
    containerManagerFactory,
    validationEngine,
    enqueueSession,
    logger,
    validationRepo,
    scanRepo,
    assertExecutionTerminationVerified,
    resolveEffectiveBoundProfile,
    beginGoalTaskRework,
    taskFeedbackEvents,
    destroyPodNetwork,
    cleanupContainer,
    stopSandboxPreviewProxy,
    killSidecarsForPod,
    cleanupTestRunBranches,
    validationAbortControllers,
    ownsLifecycle,
    pendingUpdateFromBaseIntents,
    parkFixPodDeliveryFailure,
    isParkedHostPushRecovery,
    runUpdateFromBaseAfterAbort,
    persistRuntimeCredentialsForPod,
    prepareWorkspaceForValidation,
    preservePodWorkspace,
    checkpointSandboxWorkspaceForPod,
    startValidationAttempt,
    prepareValidationInputs,
    buildPhaseEventCallbacks,
    ownedValidationCallbacks,
    recordValidationProvenance,
    withReviewerLaunchPreflight,
    validateWithInfrastructureRetries,
    collectValidationEvidence,
    publishValidationResult,
    parkOnRetryAdmission,
    parkOnValidationInfrastructureFailure,
    parkOnReviewInfrastructureFailure,
    emitActivityStatus,
    emitActivityError,
    sanitizeFailureReason,
    tryRecoverAfterWorkspaceSyncFailure,
    parkOnWorktreeSyncFailure,
    transition,
    applySkipValidationDecision,
    claimValidation,
    maybeTriggerDependents,
    completeValidationPass,
  });

  const { completeRevalidationPass } = createRevalidationPassDelivery({
    warnIfSinglePrSeriesMissingSeriesMeta,
    resolvePrBaseBranch,
    podRepo,
    containerManagerFactory,
    worktreeManager,
    validationEngine,
    logger,
    prManagerFactory,
    resolveGitCredential,
    refreshReadiness,
    getLatestPushFindings,
    emitActivityStatus,
    advisoryPublicationOwnership,
    runAdvisoryAfterValidation,
    handleDeletionGuardError,
    ensurePrBaseBranchOnOrigin,
    transition,
    maybeTriggerDependents,
  });
  const validationRevalidationWorkflow = createValidationRevalidationWorkflow(deps, {
    CONTAINER_APP_PORT,
    podRepo,
    eventBus,
    containerManagerFactory,
    worktreeManager,
    validationEngine,
    enqueueSession,
    logger,
    validationRepo,
    executionForPod,
    validationEnvironmentForPod,
    assertExecutionTerminationVerified,
    assertGuidanceCollected,
    resolveGitCredential,
    runPushCheckpointScan,
    validationAbortControllers,
    buildReviewerExecEnv,
    getEffectiveReviewerConfig,
    getReviewerExecutor,
    prepareWorkspaceForValidation,
    buildPhaseEventCallbacks,
    validateWithInfrastructureRetries,
    publishValidationResult,
    parkOnRetryAdmission,
    parkOnValidationInfrastructureFailure,
    parkOnReviewInfrastructureFailure,
    emitActivityStatus,
    emitActivityError,
    sanitizeFailureReason,
    tryRecoverAfterWorkspaceSyncFailure,
    parkOnWorktreeSyncFailure,
    transition,
    applySkipValidationDecision,
    claimValidation,
    maybeTriggerDependents,
    completeRevalidationPass,
  });

  const provisioningWorkflow = createProvisioningWorkflow(deps, {
    materializeSpecFiles,
    captureDeployBaselineHashes,
    podRepo,
    profileStore,
    providerAccountStore,
    providerCatalog,
    containerManagerFactory,
    worktreeManager,
    logger,
    repoScanner,
    executionCredentialsFor,
    resolveGitCredential,
    assertSandboxAgentStreamingExecSupported,
    destroyPodNetwork,
    stopSandboxPreviewProxy,
    killSidecarsForPod,
    closeProviderAttempt,
    resolveEffectiveBoundProfile,
    openProviderTargetAttempt,
    persistRuntimeCredentialsForPod,
    syncWorkspaceBack,
    transition,
    allocateHostPort,
    CONTAINER_APP_PORT,
    execFileAsync,
    networkManager,
    sidecarManager,
    mcpBaseUrl,
    injectionsForPod,
    startHaproxyDenyReceiver,
    hostnameFromUrl,
    portFromUrl,
    buildPrFixTask,
    fixFeedbackRepo,
    escalationRepo,
    validationRepo,
    progressEventRepo,
    safetyEventsRepo,
    rememberMaxCredentialLineage,
    emitActivityStatus,
  });
  const processWorkflow = createAgentProcessWorkflow(deps, {
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
  });

  const agentEventConsumption = createAgentEventConsumption(deps, {
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
  });
  const completionWorkflow = createCompletionWorkflow(deps, {
    podRepo,
    holdCompletionForHumanWork,
    artifactCompletionRuns,
    finalizeArtifactPod,
    prepareSourceForCompletion,
    applyCompletionDecision,
  });
  const { prepareApprovalDelivery } = createApprovalDeliveryPreparation({
    podRepo,
    assertApprovalCurrent,
    executionForPod,
    worktreeManager,
    emitActivityError,
    containerManagerFactory,
    logger,
    prManagerFactory,
    emitActivityStatus,
    failBranchPreservation,
    forceWithLeaseAllowances,
    transition,
    persistReadinessApproval,
    cleanupContainerAfterAdvisorySettles,
    eventBus,
    maybeTriggerDependents,
  });
  const { executeApprovalDelivery } = createApprovalDeliveryExecution({
    podRepo,
    assertApprovalCurrent,
    executionForPod,
    worktreeManager,
    emitActivityError,
    logger,
    prManagerFactory,
    emitActivityStatus,
    forceWithLeaseAllowances,
    transition,
    resolveGitCredential,
    mergeQueue,
    formatRebaseConflictReason,
    startMergePolling,
    resolvePrBaseBranch,
    ensurePrBaseBranchOnOrigin,
    getLatestPushFindings,
    handleDeletionGuardError,
  });
  const approvalWorkflow = createApprovalWorkflow({
    podRepo,
    resolveApprovalReadiness,
    assertApprovalCurrent,
    logger,
    emitActivityStatus,
    transition,
    persistReadinessApproval,
    cleanupContainerAfterAdvisorySettles,
    eventBus,
    maybeTriggerDependents,
    prepareApprovalDelivery,
    executeApprovalDelivery,
  });

  const approvalControls = createApprovalControls({
    podRepo,
    resolveApprovalReadiness,
    logger,
    nudgeRepo,
    validationRepo,
    emitActivityStatus,
    escalationRepo,
    transition,
    maybeTriggerDependents,
    refreshReadiness,
  });
  const fixControls = createFixControls({
    podRepo,
    executionForPod,
    transition,
    emitActivityStatus,
    startMergePolling,
    logger,
    fixFeedbackRepo,
    maybeSpawnFixSession,
    isFixCycleTerminal,
  });
  const operatorMessages = createOperatorMessages(deps, {
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
  });
  const operatorRejection = createOperatorRejection({
    podRepo,
    resolveEffectiveBoundProfile,
    beginGoalTaskRework,
    emitActivityStatus,
    transition,
    containerManagerFactory,
    logger,
    taskFeedbackEvents,
    persistRuntimeCredentialsForPod,
  });
  const operatorPause = createOperatorPause(deps, {
    pauseIntents,
    podRepo,
    emitActivityStatus,
    activeAgentRuns,
    logger,
    runtimeRegistry,
    transition,
  });
  const operatorKill = createOperatorKill(deps, {
    podRepo,
    clearPreviewTimer,
    stopSandboxPreviewProxy,
    stopMergePolling,
    emitActivityStatus,
    transition,
    validationAbortControllers,
    killSidecarsForPod,
    cleanupTestRunBranches,
    containerManagerFactory,
    persistRuntimeCredentialsForPod,
    ownsLifecycle,
    logger,
    destroyPodNetwork,
    runtimeRegistry,
    worktreeManager,
    forgetMaxCredentialLineage,
    eventBus,
  });
  const operatorControls = createOperatorControls({
    podRepo,
    nudgeRepo,
    emitActivityStatus,
    logger,
    transition,
  });
  const operatorTools = createOperatorTools({
    podRepo,
    containerManagerFactory,
    emitActivityStatus,
    installGhBinary,
    installAzViaPip,
  });
  const resourcePreviewControls = createResourcePreviewControls({
    podRepo,
    containerManagerFactory,
    executionForPod,
    ensureSandboxPreviewProxy,
    schedulePreviewAutoStop,
    logger,
    clearPreviewTimer,
    stopSandboxPreviewProxy,
  });
  const workspaceArtifactObservation = createWorkspaceArtifactObservation(deps, {
    assertExecutionTerminationVerified,
    assertGuidanceCollected,
    podRepo,
    artifactResumeRuns,
    artifactCompletionRuns,
  });

  const workspaceEscapeControls = createWorkspaceEscapeControls({
    podRepo,
    cleanupContainer,
    transition,
    emitActivityStatus,
    logger,
    maybeTriggerDependents,
    clearStuckQueueEntry,
    enqueueSession,
    validationAbortControllers,
  });

  const workspaceDeletion = createWorkspaceDeletion({
    podRepo,
    executionForPod,
    clearPreviewTimer,
    stopSandboxPreviewProxy,
    killSidecarsForPod,
    containerManagerFactory,
    destroyPodNetwork,
    cleanupTestRunBranches,
    worktreeManager,
    pendingUpdateFromBaseIntents,
    forceWithLeaseAllowances,
    logger,
  });

  const workspaceManualFix = createWorkspaceManualFix(deps, {
    podRepo,
    assertExecutionTerminationVerified,
    logger,
    emitActivityStatus,
  });

  const workspaceRecoveryCommands = createWorkspaceRecoveryCommands({
    preservePodWorkspace,
    podRepo,
    containerManagerFactory,
    emitActivityStatus,
    killSidecarsForPod,
    destroyPodNetwork,
    checkpointSandboxWorkspaceForPod,
    recoverWorktreeFromContainer,
    executionForPod,
    worktreeManager,
    logger,
  });

  const workspaceBranchSync = createWorkspaceBranchSync({
    podRepo,
    containerManagerFactory,
    syncWorkspaceBack,
    logger,
    executionForPod,
    worktreeManager,
    resolveGitCredential,
  });

  const workspaceCompletion = createWorkspaceCompletion(deps, {
    podRepo,
    coordinateInteractiveCompletion,
    assertInteractiveCompletionCurrent,
    preserveArtifacts,
    failInteractivePreservation,
    containerManagerFactory,
    syncWorkspaceBack,
    logger,
    executionForPod,
    runPushCheckpointScan,
    resolveGitCredential,
    worktreeManager,
    handleDeletionGuardError,
    emitActivityStatus,
    cleanupContainer,
    transition,
    eventBus,
  });

  const workspacePromotion = createWorkspacePromotion(deps, {
    podRepo,
    executionForPod,
    transition,
    enqueueSession,
    logger,
    profileStore,
    eventBus,
  });
  const admissionSeries = createAdmissionSeriesDeletion({ podRepo, logger });

  const admissionQueries = createAdmissionQueries(deps, {
    podRepo,
    executionCredentialsFor,
    executionForPod,
    injectionsForPod,
    validationRepo,
  });

  const admissionAnalysis = createAdmissionAnalysisWorkspaces(deps);

  const admissionLegacy = createAdmissionLegacy(deps, {
    podRepo,
    profileStore,
    providerAccountStore,
    providerCatalog,
    containerManagerFactory,
    assertSandboxAgentStreamingExecSupported,
    executionForPod,
    logger,
    eventBus,
    enqueueSession,
  });

  const admissionResolved = createAdmissionResolved(deps, {
    providerAccountStore,
    providerCatalog,
    containerManagerFactory,
    assertSandboxAgentStreamingExecSupported,
    podRepo,
    eventBus,
    enqueueSession,
    maybeTriggerDependents,
  });

  const terminationReconciliation = createTerminationReconciliation({
    podRepo,
    getContainerManager: () => containerManagerFactory.get('sandbox'),
    isAgentActive: (podId) => activeAgentRuns.has(podId),
    emitActivityStatus,
  });

  return createPodManagerFacade({
    terminationReconciliation,
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
  });
}
