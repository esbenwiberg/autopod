import { type OperatorActor, type Pod, PodNotFoundError } from '@autopod/shared';
import {
  type SandboxRecoveryReceipt,
  type SandboxRecoveryRequest,
  recoveryError,
  recoveryHash,
} from '../containers/sandbox-recovery-journal.js';
import type { ContainerManager } from '../interfaces/container-manager.js';
import type { PodRepository } from './pod-repository.js';
import { assertValidationMutationSettled } from './validation-recovery-policy.js';

export function createSandboxRecovery(deps: {
  podRepo: PodRepository;
  getContainerManager(): ContainerManager;
  isIdle(podId: string): boolean;
  isGoal(podId: string): boolean;
  deleteSession(podId: string): Promise<void>;
}) {
  const journal = deps.podRepo.sandboxWakeups;
  const ledger = journal?.recovery;
  const flights = new Map<string, Promise<void>>();
  const active = new Map<string, string>();
  const binding = (p: Pod) =>
    recoveryHash([
      p.id,
      p.lifecycleGeneration,
      p.status,
      p.containerId,
      p.executionTarget,
      p.worktreePath,
      p.branch,
      p.runtime,
      p.launchConfigDigest,
      p.lastValidationResult,
    ]);
  const validationEvidence = (pod: Pod, sandboxId: string) => {
    const validations = deps.podRepo.validationExecutions;
    if (!validations) recoveryError('Durable validation custody ledger is required');
    return validations.captureAbandonment(
      pod,
      sandboxId,
      deps.getContainerManager().executionResourceScope,
    );
  };
  const selectionBinding = (pod: Pod, evidence: string | null) =>
    evidence ? recoveryHash([binding(pod), evidence]) : binding(pod);
  function policy(
    podId: string,
    action: 'start' | 'abandon',
    owner?: string,
    sandboxId?: string,
    completedCleanup?: SandboxRecoveryReceipt,
  ) {
    if (active.has(podId) && active.get(podId) !== owner)
      recoveryError('Another sandbox recovery is in flight');
    const pod = deps.podRepo.getOrThrow(podId);
    if (!journal || !ledger) recoveryError('Durable sandbox recovery is unavailable');
    if (
      pod.executionTarget !== 'sandbox' ||
      !['failed', 'review_required', 'validated', 'complete', 'killed'].includes(pod.status)
    )
      recoveryError(
        'Recovery requires an idle retained sandbox pod. Pause/stop active work through its normal controls first.',
      );
    if (!deps.isIdle(podId)) recoveryError('A task invocation is still active');
    if (deps.isGoal(podId))
      recoveryError(
        'Native Goal custody requires Goal-aware recovery; these sandbox-only controls cannot override it.',
      );
    if (action === 'start') assertValidationMutationSettled(deps.podRepo, podId);
    else validationEvidence(pod, sandboxId ?? pod.containerId ?? '');
    if (
      !deps.podRepo.taskExecutions ||
      !deps.podRepo.sourceAdoptions ||
      !deps.podRepo.externalDeliveries
    )
      recoveryError('Worker, source and delivery custody ledgers are required');
    deps.podRepo.taskExecutions.assertCanDelete(podId);
    deps.podRepo.sourceAdoptions.assertDeletable(podId);
    deps.podRepo.externalDeliveries.assertDeletable(podId);
    // Post-404 cleanup resumes through deleteSession's exact durable cleanup
    // claim. That claim, not a blanket availability check, fences active attempts.
    if (
      !completedCleanup?.completedAt ||
      completedCleanup.sandboxId !== sandboxId ||
      selectionBinding(pod, validationEvidence(pod, completedCleanup.sandboxId)) !==
        completedCleanup.binding
    )
      deps.podRepo.deletionOwnership?.assertTaskAvailable(podId);
    if (deps.podRepo.retainedCheckpoints?.latest(podId))
      recoveryError('Retained checkpoint recovery still owns original evidence');
    if (pod.pendingEscalation || deps.podRepo.hasUnansweredDecision?.(podId))
      recoveryError('Resolve pending task decisions first');
    return pod;
  }
  const reasonFor = (operation: () => void) => {
    try {
      operation();
      return null;
    } catch (error) {
      return error instanceof Error ? error.message : 'Recovery is blocked';
    }
  };
  async function inspect(podId: string) {
    const pod = deps.podRepo.getOrThrow(podId);
    if (!ledger || !journal) recoveryError('Durable sandbox recovery is unavailable');
    const original = binding(pod);
    const resources = ledger.resources(podId);
    const cm =
      pod.executionTarget === 'sandbox' || resources.length
        ? deps.getContainerManager()
        : undefined;
    if (
      pod.executionTarget === 'sandbox' &&
      pod.containerId &&
      !resources.some((r) => r.sandboxId === pod.containerId)
    ) {
      if (!cm?.getResourceKey) recoveryError('Exact provider resource binding is unavailable');
      resources.push({
        sandboxId: pod.containerId,
        resourceKey: await cm.getResourceKey(pod.containerId),
      });
    }
    const operations = ledger.list(podId);
    const observations = [];
    for (const resource of resources) {
      let providerState: 'running' | 'stopped' | 'deleted' | 'unknown' = 'unknown';
      let observationError: string | null = null;
      let namespaceVerified = false;
      try {
        if (
          !cm?.getResourceKey ||
          (await cm.getResourceKey(resource.sandboxId)) !== resource.resourceKey
        )
          recoveryError('Original resource belongs to a different provider namespace');
        namespaceVerified = true;
        providerState = await cm.getStatus(resource.sandboxId);
      } catch (error) {
        observationError = error instanceof Error ? error.message : 'Provider observation failed';
      }
      if (binding(deps.podRepo.getOrThrow(podId)) !== original)
        recoveryError('Pod changed during inspection. Refresh.', 'STALE_SANDBOX_RECOVERY');
      if (providerState === 'running' && !observationError) {
        for (const operation of operations) {
          if (
            operation.action === 'start' &&
            !operation.completedAt &&
            operation.resourceKey === resource.resourceKey &&
            operation.binding === original
          )
            ledger.complete(operation.id, 'running');
        }
      }
      const pendingIntentIds = ledger.pendingIntents(resource.resourceKey);
      const abandoned = [...operations]
        .reverse()
        .find((r) => r.action === 'abandon' && r.resourceKey === resource.resourceKey);
      const policyBlock = reasonFor(() => {
        policy(podId, 'start');
      });
      let currentAbandonment: SandboxRecoveryReceipt | undefined;
      const abandonmentPolicyBlock = reasonFor(() => {
        const evidence = validationEvidence(pod, resource.sandboxId);
        currentAbandonment =
          abandoned?.binding === selectionBinding(pod, evidence) ? abandoned : undefined;
        policy(
          podId,
          'abandon',
          undefined,
          resource.sandboxId,
          currentAbandonment?.completedAt ? currentAbandonment : undefined,
        );
      });
      const startBlocked =
        observationError ??
        policyBlock ??
        (abandoned
          ? 'Sandbox has an explicit abandonment decision.'
          : providerState === 'deleted'
            ? 'Sandbox was deleted.'
            : providerState === 'unknown'
              ? 'Provider readiness is unknown.'
              : pendingIntentIds.length
                ? 'Original resume outcome is unknown. No blind replay is permitted; Azure operation evidence is required.'
                : resource.sandboxId !== pod.containerId
                  ? 'Original resource is no longer the current pod sandbox.'
                  : null);
      // Explicit loss acceptance authorizes DELETE, not a readiness inference.
      // Unavailable state can never authorize START, but need not strand abandonment.
      const abandonBlocked =
        (namespaceVerified ? null : observationError) ?? abandonmentPolicyBlock;
      observations.push({
        ...resource,
        providerState,
        observedAt: new Date().toISOString(),
        observationError,
        pendingIntentIds,
        startBlocked,
        abandonBlocked,
        abandonment: currentAbandonment ?? null,
      });
    }
    return {
      podId,
      generation: pod.lifecycleGeneration,
      resources: observations,
      operations: ledger.list(podId),
      wakeups: journal.listForPod(podId),
    };
  }
  async function execute(record: SandboxRecoveryReceipt) {
    if (!ledger || !journal) recoveryError('Durable sandbox recovery is unavailable');
    const cm = deps.getContainerManager();
    const assertCurrent = () => {
      const pod = policy(record.podId, record.action, record.id, record.sandboxId);
      const evidence =
        record.action === 'abandon' ? validationEvidence(pod, record.sandboxId) : null;
      if (
        evidence !== record.validationEvidence ||
        pod.lifecycleGeneration !== record.generation ||
        selectionBinding(pod, evidence) !== record.binding
      )
        recoveryError(
          'Recovery selection was superseded. No mutation was authorized.',
          'STALE_SANDBOX_RECOVERY',
        );
    };
    assertCurrent();
    if (!cm.getResourceKey || (await cm.getResourceKey(record.sandboxId)) !== record.resourceKey)
      recoveryError('Exact provider namespace changed', 'STALE_SANDBOX_RECOVERY');
    assertCurrent();
    let status: Awaited<ReturnType<ContainerManager['getStatus']>>;
    try {
      status = await cm.getStatus(record.sandboxId);
    } catch (error) {
      if (record.action === 'start') throw error;
      status = 'unknown';
    }
    assertCurrent();
    if (record.action === 'start') {
      if (status === 'running') {
        ledger.complete(record.id, 'running');
        return;
      }
      journal.recovery.assertWakeable(record.sandboxId);
      if (ledger.hasDispatched(record.id))
        recoveryError(
          'This start request was already admitted. Check status; reusing its ID never dispatches another resume.',
          'SANDBOX_RECOVERY_OUTCOME_UNVERIFIED',
        );
      // The Azure adapter commits/rechecks its own durable single-resume intent.
      ledger.append(record.id, 'dispatch');
      await cm.start(record.sandboxId, { assertCurrent });
      assertCurrent();
      if ((await cm.getStatus(record.sandboxId)) !== 'running')
        recoveryError('Sandbox startup is unverified');
      assertCurrent();
      ledger.complete(record.id, 'running');
      return;
    }
    if (status !== 'deleted') {
      ledger.append(record.id, 'dispatch');
      await ledger.withAbandonment(record.id, assertCurrent, () => cm.kill(record.sandboxId));
    }
    assertCurrent();
    if ((await cm.getStatus(record.sandboxId)) !== 'deleted')
      recoveryError(
        'Deletion is not confirmed. Resource and original wakeup evidence remain retained.',
      );
    assertCurrent();
    ledger.complete(record.id, 'deleted');
  }
  async function submit(podId: string, input: SandboxRecoveryRequest, actor: OperatorActor) {
    if (!ledger || !journal) recoveryError('Durable sandbox recovery is unavailable');
    if (
      actor.type !== 'human' ||
      !actor.userId.trim() ||
      input.reason.trim().length < 10 ||
      input.reason.length > 4000 ||
      !/^[a-zA-Z0-9-]{1,64}$/.test(input.id)
    )
      recoveryError('Authenticated human, stable request ID and meaningful reason required');
    if (input.action === 'abandon' && !input.acknowledgeDataLoss)
      recoveryError('Explicit acknowledgement of unpreserved data loss is required');
    const hash = recoveryHash([podId, input, actor]);
    let record = ledger.get(input.id);
    if (record && record.requestHash !== hash)
      recoveryError('Recovery request ID conflict', 'SANDBOX_RECOVERY_CONFLICT');
    if (!record) {
      const pod = policy(podId, input.action, undefined, input.sandboxId);
      if (pod.lifecycleGeneration !== input.expectedGeneration)
        recoveryError('Pod generation changed. Refresh.', 'STALE_SANDBOX_RECOVERY');
      const snapshot = await inspect(podId);
      const resource = snapshot.resources.find(
        (r) => r.sandboxId === input.sandboxId && r.resourceKey === input.expectedResourceKey,
      );
      if (!resource) recoveryError('Selected original sandbox is unavailable');
      const block = input.action === 'start' ? resource.startBlocked : resource.abandonBlocked;
      if (block) recoveryError(block);
      const current = policy(podId, input.action, undefined, input.sandboxId);
      if (binding(current) !== binding(pod))
        recoveryError('Pod changed. Refresh.', 'STALE_SANDBOX_RECOVERY');
      record = ledger.admit({
        id: input.id,
        podId,
        sandboxId: input.sandboxId,
        resourceKey: input.expectedResourceKey,
        generation: input.expectedGeneration,
        action: input.action,
        userId: actor.userId,
        reason: input.reason,
        requestHash: hash,
        binding: selectionBinding(
          pod,
          input.action === 'abandon' ? validationEvidence(pod, input.sandboxId) : null,
        ),
        intentIds: resource.pendingIntentIds,
        validationEvidence:
          input.action === 'abandon' ? validationEvidence(pod, input.sandboxId) : null,
      });
    }
    if (!record.completedAt) {
      const running = flights.get(record.id);
      if (running) await running;
      else {
        // A repeated start request is observation only after the first admission.
        // Existing wakeup intent also prevents replay across process restart.
        active.set(podId, record.id);
        const operation = execute(record);
        flights.set(record.id, operation);
        try {
          await operation;
        } catch (error) {
          ledger.append(record.id, 'unverified');
          throw error;
        } finally {
          flights.delete(record.id);
          active.delete(podId);
        }
      }
    }
    let podDeleted = false;
    let cleanupError: string | null = null;
    if (record.action === 'abandon' && ledger.get(record.id)?.completedAt) {
      let current: Pod | undefined;
      try {
        current = deps.podRepo.getOrThrow(podId);
      } catch (error) {
        if (!(error instanceof PodNotFoundError)) throw error;
      }
      if (!current) podDeleted = true;
      else {
        try {
          const completed = record;
          const assertCleanupCurrent = () => {
            const selected = deps.podRepo.getOrThrow(podId);
            const evidence = validationEvidence(selected, completed.sandboxId);
            if (
              evidence !== completed.validationEvidence ||
              selectionBinding(selected, evidence) !== completed.binding
            )
              recoveryError(
                'Original pod or validation selection changed; sandbox deletion does not authorize deleting its replacement.',
                'STALE_SANDBOX_RECOVERY',
              );
          };
          await ledger.withAbandonmentCleanup(completed.id, assertCleanupCurrent, () =>
            deps.deleteSession(podId),
          );
          podDeleted = true;
        } catch (error) {
          cleanupError = error instanceof Error ? error.message : 'Pod cleanup remains blocked';
        }
      }
    }
    return {
      operation: ledger.get(record.id) ?? recoveryError('Recovery receipt unavailable'),
      podDeleted,
      cleanupError,
    };
  }
  function assertAvailable(podId: string, operation?: string) {
    if (active.has(podId)) recoveryError('Sandbox recovery is in flight');
    ledger?.assertAvailable(podId);
    if (operation !== 'deleteSession' && ledger?.list(podId).some((r) => r.action === 'abandon'))
      recoveryError(
        'Sandbox was explicitly abandoned. Finish pod deletion; continuing work is not authorized.',
        'SANDBOX_ABANDONED',
      );
  }
  return { inspect, submit, assertAvailable };
}
