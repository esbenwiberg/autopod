import type { createContinuationControls } from './continuation-controls.js';
import type { createProviderContinuation } from './provider-continuation.js';
import type { createValidationRevalidationWorkflow } from './validation-revalidation-workflow.js';
import type { createValidationTriggerWorkflow } from './validation-trigger-workflow.js';
import type { createValidationWorkflowControls } from './validation-workflow-controls.js';

import type { createAdmissionAnalysisWorkspaces } from './admission-analysis-workspaces.js';
import type { createAdmissionDependents } from './admission-dependents.js';
import type { createAdmissionExecutionContext } from './admission-execution-context.js';
import type { createAdmissionLegacy } from './admission-legacy.js';
import type { createAdmissionMemoryContext } from './admission-memory-context.js';
import type { createAdmissionQueries } from './admission-queries.js';
import type { createAdmissionResolved } from './admission-resolved.js';
import type { createAdmissionSeriesDeletion } from './admission-series-deletion.js';
import type { createAgentActivity } from './agent-activity.js';
import type { createAgentEventConsumption } from './agent-event-consumption.js';
import type { createAgentProcessWorkflow } from './agent-process-workflow.js';
import type { createApprovalControls } from './approval-controls.js';
import type { createApprovalWorkflow } from './approval-workflow.js';
import type { createCompletionWorkflow } from './completion-workflow.js';
import type { createDeliveryPr } from './delivery-pr.js';
import type { createFixControls } from './fix-controls.js';
import type { createOperatorControls } from './operator-controls.js';
import type { createOperatorKill } from './operator-kill.js';
import type { createOperatorMessages } from './operator-messages.js';
import type { createOperatorPause } from './operator-pause.js';
import type { createOperatorRejection } from './operator-rejection.js';
import type { createOperatorTools } from './operator-tools.js';
import type { PodRepository } from './pod-repository.js';
import type { createResourceNetwork } from './resource-network.js';
import type { createResourcePreviewControls } from './resource-preview-controls.js';
import type { createReviewerContext } from './reviewer-context.js';
import type { createTerminationReconciliation } from './termination-reconciliation.js';
import type { createValidationEnvironment } from './validation-environment.js';
import type { createWorkspaceArtifactObservation } from './workspace-artifact-observation.js';
import type { createWorkspaceBranchSync } from './workspace-branch-sync.js';
import type { createWorkspaceCompletion } from './workspace-completion.js';
import type { createWorkspaceDeletion } from './workspace-deletion.js';
import type { createWorkspaceEscapeControls } from './workspace-escape-controls.js';
import type { createWorkspaceManualFix } from './workspace-manual-fix.js';
import type { createWorkspacePromotion } from './workspace-promotion.js';
import type { createWorkspaceRecoveryCommands } from './workspace-recovery-commands.js';
import type { createWorkspaceWatchdog } from './workspace-watchdog.js';
export interface PodFacadeOwners {
  admissionQueries: Pick<
    ReturnType<typeof createAdmissionQueries>,
    | 'getLaunchConfiguration'
    | 'getSession'
    | 'getExternalDelivery'
    | 'getDeploymentConfiguration'
    | 'getInjectedMcpServer'
    | 'getInjectedMcpServers'
    | 'listSessions'
    | 'getSessionStats'
    | 'getSeriesPods'
    | 'getValidationHistory'
  >;
  admissionResolved: Pick<ReturnType<typeof createAdmissionResolved>, 'createResolvedSession'>;
  admissionLegacy: Pick<ReturnType<typeof createAdmissionLegacy>, 'createSession'>;
  admissionAnalysis: Pick<
    ReturnType<typeof createAdmissionAnalysisWorkspaces>,
    'createHistoryWorkspace' | 'createMemoryWorkspace'
  >;
  continuationControls: Pick<
    ReturnType<typeof createContinuationControls>,
    'resumeNativeGoal' | 'assertCanRework' | 'assertCanRetryValidation' | 'resumePod'
  >;
  processWorkflow: Pick<ReturnType<typeof createAgentProcessWorkflow>, 'processPod'>;
  agentEventConsumption: Pick<ReturnType<typeof createAgentEventConsumption>, 'consumeAgentEvents'>;
  completionWorkflow: Pick<ReturnType<typeof createCompletionWorkflow>, 'handleCompletion'>;
  operatorMessages: Pick<ReturnType<typeof createOperatorMessages>, 'sendMessage'>;
  approvalWorkflow: Pick<ReturnType<typeof createApprovalWorkflow>, 'approveSession'>;
  operatorRejection: Pick<ReturnType<typeof createOperatorRejection>, 'rejectSession'>;
  operatorPause: Pick<ReturnType<typeof createOperatorPause>, 'pauseSession'>;
  operatorControls: Pick<
    ReturnType<typeof createOperatorControls>,
    'nudgeSession' | 'notifyEscalation' | 'killAllFailed'
  >;
  operatorKill: Pick<ReturnType<typeof createOperatorKill>, 'killSession'>;
  workspacePromotion: Pick<ReturnType<typeof createWorkspacePromotion>, 'promoteToAuto'>;
  workspaceCompletion: Pick<ReturnType<typeof createWorkspaceCompletion>, 'completeSession'>;
  workspaceBranchSync: Pick<ReturnType<typeof createWorkspaceBranchSync>, 'syncWorkspaceBranch'>;
  workspaceRecoveryCommands: Pick<
    ReturnType<typeof createWorkspaceRecoveryCommands>,
    | 'preserveWorkspace'
    | 'quiesceSandboxAgent'
    | 'suspendSandboxForRecovery'
    | 'cleanupPodResourcesForRecovery'
    | 'recoverWorktree'
  >;
  validationTriggerWorkflow: Pick<
    ReturnType<typeof createValidationTriggerWorkflow>,
    'triggerValidation'
  >;
  validationRevalidationWorkflow: Pick<
    ReturnType<typeof createValidationRevalidationWorkflow>,
    'revalidateSession'
  >;
  workspaceManualFix: Pick<ReturnType<typeof createWorkspaceManualFix>, 'fixManually'>;
  touchHeartbeat: ReturnType<typeof createAgentActivity>['touchHeartbeat'];
  getEffectiveReviewerConfig: ReturnType<
    typeof createReviewerContext
  >['getEffectiveReviewerConfig'];
  buildReviewerExecEnv: ReturnType<typeof createReviewerContext>['buildReviewerExecEnv'];
  getReviewerExecutor: ReturnType<typeof createReviewerContext>['getReviewerExecutor'];
  admissionMemory: Pick<
    ReturnType<typeof createAdmissionMemoryContext>,
    'getProjectMemoryScope' | 'getLaunchMemoryContext'
  >;
  workspaceDeletion: Pick<ReturnType<typeof createWorkspaceDeletion>, 'deleteSession'>;
  resourcePreviewControls: Pick<
    ReturnType<typeof createResourcePreviewControls>,
    'startPreview' | 'stopPreview' | 'previewStatus'
  >;
  approvalControls: Pick<
    ReturnType<typeof createApprovalControls>,
    | 'refreshReadinessAfterQualityScore'
    | 'approveAllValidated'
    | 'approveFactWaiver'
    | 'forceApprove'
  >;
  podRepo: Pick<PodRepository, 'getOrThrow'>;
  validationEnvironmentForPod: ReturnType<
    typeof createValidationEnvironment
  >['validationEnvironmentForPod'];
  executionForPod: ReturnType<typeof createAdmissionExecutionContext>['executionForPod'];
  admissionDependents: Pick<
    ReturnType<typeof createAdmissionDependents>,
    'rehydrateDependentSessions'
  >;
  admissionSeries: Pick<
    ReturnType<typeof createAdmissionSeriesDeletion>,
    'deleteSeriesWithCascade'
  >;
  validationWorkflowControls: Pick<
    ReturnType<typeof createValidationWorkflowControls>,
    | 'extendAttempts'
    | 'applyOverridesInstant'
    | 'interruptValidation'
    | 'updateFromBase'
    | 'setSkipValidation'
  >;
  fixControls: Pick<
    ReturnType<typeof createFixControls>,
    'extendPrAttempts' | 'spawnFixSession' | 'requestFixSession'
  >;
  resourceNetwork: Pick<ReturnType<typeof createResourceNetwork>, 'refreshNetworkPolicy'>;
  operatorTools: Pick<
    ReturnType<typeof createOperatorTools>,
    'injectCredential' | 'installCliTool'
  >;
  retryCreatePr: ReturnType<typeof createDeliveryPr>['retryCreatePr'];
  workspaceArtifactObservation: Pick<
    ReturnType<typeof createWorkspaceArtifactObservation>,
    'getArtifactResumeObservation'
  >;
  providerContinuation: Pick<ReturnType<typeof createProviderContinuation>, 'continueProvider'>;
  terminationReconciliation: ReturnType<typeof createTerminationReconciliation>;
  workspaceEscapeControls: Pick<
    ReturnType<typeof createWorkspaceEscapeControls>,
    'forceComplete' | 'kickPod'
  >;
  workspaceWatchdog: Pick<
    ReturnType<typeof createWorkspaceWatchdog>,
    'startStuckPodWatchdog' | 'stopStuckPodWatchdog'
  >;
}
