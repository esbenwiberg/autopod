import path from 'node:path';
import type {
  OperatorActor,
  ValidationExecutionRecoveryRequest,
  ValidationExecutionRecoveryState,
} from '@autopod/shared';
import type { ContainerManager } from '../interfaces/container-manager.js';
import { readArtifactSnapshotFile, verifyArtifactSnapshot } from './artifact-snapshot-receipt.js';
import type { PodRepository } from './pod-repository.js';
import {
  assertRecoveryActor,
  validationRecoveryError,
  validationResultHash,
} from './validation-execution-ledger.js';
import {
  assertValidationFinalContentSupported,
  requiresValidationSettlement,
} from './validation-recovery-policy.js';

export function createValidationExecutionRecovery(deps: {
  podRepo: PodRepository;
  getContainerManager(): ContainerManager;
  isActive(podId: string, exceptCurrent?: 'authorizeValidationRecoveryBudget'): boolean;
  dataDir?: string;
}) {
  const ledger = deps.podRepo.validationExecutions;
  const root = (podId: string) =>
    path.join(
      deps.dataDir ?? process.env.DATA_DIR ?? path.join(process.cwd(), '.autopod-data'),
      'validation-recovery',
      podId,
    );
  const assertIdle = (podId: string, exceptCurrent?: 'authorizeValidationRecoveryBudget') => {
    const pod = deps.podRepo.getOrThrow(podId);
    deps.podRepo.sourceAdoptions?.assertAvailable(podId, '');
    if (deps.podRepo.sourceAdoptions?.hasCustody(podId))
      validationRecoveryError(
        'Source/report custody remains held; validation reconciliation cannot release or delete its original resource.',
        'SOURCE_CUSTODY_HELD',
      );
    deps.podRepo.sourceAdoptions?.assertControlPlaneSettled(podId);
    deps.podRepo.sandboxWakeups?.assertPodReleasable(podId);
    if (pod.containerId) {
      deps.podRepo.sandboxWakeups?.assertReleasable(pod.containerId);
      if (deps.podRepo.externalDeliveries?.retains(pod.containerId))
        validationRecoveryError('External delivery retains original reports and resource custody');
    }
    if (
      !['failed', 'review_required'].includes(pod.status) ||
      pod.lastValidationResult?.overall !== 'fail' ||
      pod.pendingEscalation ||
      deps.podRepo.hasUnansweredDecision?.(podId) ||
      !pod.worktreePath ||
      pod.worktreeCompromised ||
      deps.isActive(podId, exceptCurrent) ||
      deps.podRepo.taskExecutions?.hasActiveRun(podId)
    )
      validationRecoveryError(
        'Recovery requires retained source, failed validation and no active worker, validation or human decision',
      );
    ledger?.assertNoActiveTaskExecution(podId);
    if (ledger?.hasGoal(podId))
      validationRecoveryError(
        'Validation on a native Goal resource is unsupported by this recovery path. Retain its source and execution evidence; a Goal receipt cannot settle ordinary validation.',
        'VALIDATION_NATIVE_GOAL_RECOVERY_UNSUPPORTED',
      );
    return pod;
  };
  function getValidationExecutionRecovery(podId: string): ValidationExecutionRecoveryState {
    const pod = deps.podRepo.getOrThrow(podId);
    const exact = ledger?.find(pod);
    const unresolved = ledger?.unsettled(podId);
    const unpublished = unresolved && unresolved.id !== exact?.id ? unresolved : null;
    const required = requiresValidationSettlement(pod) || !!unresolved;
    const dispatch = unpublished ? null : exact;
    const operation = dispatch?.intent;
    const base = {
      generation: pod.lifecycleGeneration,
      validationTimestamp: unpublished
        ? unpublished.timestamp
        : (pod.lastValidationResult?.timestamp ?? null),
      resultHash: unpublished
        ? unpublished.resultHash
        : pod.lastValidationResult
          ? validationResultHash(pod.lastValidationResult)
          : null,
      dispatchId: dispatch?.id ?? unpublished?.id ?? null,
      binding: dispatch?.binding ?? unpublished?.binding ?? null,
      required,
      testBudgets: ledger?.budgets(podId) ?? [],
      preservationAttempts: dispatch ? (ledger?.preservationAttempts(dispatch.id) ?? []) : [],
      // A deletion receipt alone does not prove final source/report preservation.
      settled: false,
      receipt: operation?.receipt ?? null,
      operation: operation?.deletionStartedAt
        ? ('deletion-outcome-pending' as const)
        : operation
          ? ('preservation-required' as const)
          : null,
    };
    try {
      if (unpublished)
        validationRecoveryError(
          unpublished.published
            ? 'The immutable dispatch does not match the current task/result/resource binding. Retain its original source and reports; replacement resources cannot settle it.'
            : 'An immutable validation dispatch has no matching published result. Its returned outcome, when available, is retained separately. Preserve the exact source/reports and reconcile result-publication evidence; no worker or checks replay is admitted.',
          unpublished.published
            ? 'VALIDATION_DISPATCH_BINDING_CHANGED'
            : 'VALIDATION_RESULT_PUBLICATION_UNVERIFIED',
        );
      if (!required)
        validationRecoveryError('No unverified validation execution requires settlement');
      assertIdle(podId);
      if (!dispatch && pod.lastValidationResult?.executionDispatchId)
        validationRecoveryError(
          'The recorded validation result, task, lifecycle, cycle, provider or resource binding changed. Refresh exact ownership evidence; replacement resources cannot settle the original.',
          'VALIDATION_DISPATCH_BINDING_CHANGED',
        );
      if (!dispatch)
        validationRecoveryError(
          'No immutable validation-to-resource binding exists for this exact result. Historical provenance, worker receipts and current containerId are insufficient; preserve the original and obtain maintained dispatch evidence.',
          'VALIDATION_LEGACY_OWNERSHIP_UNAVAILABLE',
        );
      if (dispatch && !operation?.preservation && ledger?.preservationPending(dispatch.id))
        validationRecoveryError(
          'Preservation is active or interrupted without a completed snapshot receipt. Original sandbox retained; investigate the saved preservation attempt.',
          'VALIDATION_PRESERVATION_UNVERIFIED',
        );
      assertValidationFinalContentSupported();
    } catch (error) {
      return {
        ...base,
        allowed: false,
        code:
          error instanceof Error && 'code' in error
            ? String(error.code)
            : 'VALIDATION_RECOVERY_BLOCKED',
        reason: error instanceof Error ? error.message : 'Recovery blocked',
      };
    }
  }
  async function reconcileValidationExecution(
    podId: string,
    input: ValidationExecutionRecoveryRequest,
    actor: OperatorActor,
  ): Promise<ValidationExecutionRecoveryState> {
    assertRecoveryActor(actor, input.reason);
    const pod = assertIdle(podId);
    if (
      pod.lifecycleGeneration !== input.expectedGeneration ||
      !pod.lastValidationResult ||
      validationResultHash(pod.lastValidationResult) !== input.expectedResultHash
    )
      validationRecoveryError(
        'Validation changed; refresh expected generation and result hash',
        'STALE_VALIDATION_RECOVERY',
      );
    const current = getValidationExecutionRecovery(podId);
    // No current adapter can supply qualified final-content proof. Do not keep
    // a dormant resume/export/delete implementation behind this refusal.
    return validationRecoveryError(current.reason ?? 'Recovery unavailable', current.code);
  }

  function authorizeValidationRecoveryBudget(
    podId: string,
    input: ValidationExecutionRecoveryRequest & { testTimeoutSeconds: number },
    actor: OperatorActor,
  ) {
    const pod = assertIdle(podId, 'authorizeValidationRecoveryBudget');
    if (pod.executionTarget !== 'sandbox' || !deps.getContainerManager().executionResourceScope)
      validationRecoveryError('Recovery budget requires a sandbox with durable dispatch scope');
    deps.podRepo.deletionOwnership?.assertTaskAvailable(podId);
    if (
      pod.lifecycleGeneration !== input.expectedGeneration ||
      !pod.lastValidationResult ||
      validationResultHash(pod.lastValidationResult) !== input.expectedResultHash
    )
      validationRecoveryError(
        'Validation changed; refresh before selecting a budget',
        'STALE_VALIDATION_RECOVERY',
      );
    return (
      ledger?.authorizeBudget(pod, input.testTimeoutSeconds, input.reason, actor) ??
      validationRecoveryError('Validation ledger unavailable')
    );
  }
  async function readValidationEvidence(
    podId: string,
    dispatchId: string,
    resultHash: string,
    relativePath?: string,
  ) {
    const evidence =
      ledger?.evidence(podId, dispatchId, resultHash) ??
      validationRecoveryError('Validation evidence ledger unavailable');
    const preservation = evidence.preservation;
    if (!relativePath)
      return {
        dispatchId,
        resultHash,
        binding: evidence.binding,
        result: evidence.result,
        evidenceKind: evidence.evidenceKind,
        snapshotAvailable: !!preservation,
      };
    if (!preservation) return validationRecoveryError('No verified report snapshot is retained');
    const parts = relativePath.split('/');
    if (
      path.isAbsolute(relativePath) ||
      /[\\\0]/.test(relativePath) ||
      parts.some((part) => !part || part === '.' || part === '..')
    )
      validationRecoveryError('Unsafe evidence path');
    const verifySaved = () =>
      verifyArtifactSnapshot(
        preservation.snapshot,
        root(podId),
        evidence.binding.generation,
        evidence.binding.cycle,
      );
    const bytes = await readArtifactSnapshotFile(
      preservation.snapshot,
      root(podId),
      evidence.binding.generation,
      evidence.binding.cycle,
      relativePath,
    );
    await verifySaved();
    return {
      dispatchId,
      resultHash,
      path: relativePath,
      encoding: 'base64' as const,
      content: bytes.toString('base64'),
      size: bytes.length,
    };
  }
  return {
    readValidationEvidence,
    getValidationExecutionRecovery,
    reconcileValidationExecution,
    authorizeValidationRecoveryBudget,
  };
}
