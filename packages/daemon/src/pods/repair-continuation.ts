import {
  AutopodError,
  DEFAULT_CONTAINER_MEMORY_GB,
  type EffectiveLaunchConfig,
  type EnvironmentQualificationBindingV1,
  type EnvironmentQualificationEvidenceV1,
  type OperatorActor,
  type Pod,
  type RepairContinuationOperationV1,
  type RepairContinuationPreviewQueryV1,
  type RepairContinuationRefusalCode,
  type RepairContinuationRequestV1,
  repairContinuationInspectionV1Schema,
  repairContinuationOperationV1Schema,
  repairContinuationPreviewV1Schema,
  repairContinuationRequestV1Schema,
} from '@autopod/shared';
import { configurationDigest } from '../configuration/configuration-digest.js';
import {
  type RetainedExecutionSelection,
  retainedContinuationLaunch,
} from '../configuration/retained-continuation-launch.js';
import type { ContainerManager } from '../interfaces/container-manager.js';
import type { PodExecutionSettings } from '../interfaces/pod-execution-settings.js';
import type { WorktreeManager } from '../interfaces/worktree-manager.js';
import {
  assertQualificationExecutionContextSupported,
  QUALIFICATION_SOURCE_PROBE,
  qualificationExecutionContextHash,
} from './environment-qualification.js';
import type { PodRepository } from './pod-repository.js';
import { inspectRepairPrerequisiteReports } from './prerequisite-blocker.js';
import type { PreparedExecution } from './provisioning-ports.js';
import {
  type CheckpointRecoveryRecord,
  checkpointError,
  checkpointHash,
} from './retained-checkpoint-repository.js';
import type { CodingBinding } from './retained-coding-repository.js';
import {
  assertValidationExecutionSettled,
  requiresValidationSettlement,
} from './validation-recovery-policy.js';
import {
  unavailableWorkerInputs,
  WORKER_RETRY_BACKOFFS_MS,
  workerBindingHash,
} from './worker-retry-history.js';

type Dependencies = {
  podRepo: PodRepository;
  readLaunch?(podId: string): EffectiveLaunchConfig | null;
  executionForPod(pod: Pod): PodExecutionSettings;
  executionSettings?(config: EffectiveLaunchConfig): PodExecutionSettings;
  worktreeManager: WorktreeManager;
  getContainerManager(target?: Pod['executionTarget']): ContainerManager;
  assertGuidanceCollected(podId: string): void;
  assertPolicy(podId: string): void;
  selection(podId: string): { expectedGeneration: number; expectedResultHash: string } | null;
  previewExecution(podId: string, profileId: string): Promise<RetainedExecutionSelection>;
  submitCoding(
    podId: string,
    input: import('@autopod/shared').RetainedContinuationRequest,
    actor: OperatorActor,
    claim: { request: unknown; requestHash: string; binding: CodingBinding; assertCurrent(): void },
  ): Promise<CheckpointRecoveryRecord>;
  qualify(
    binding: EnvironmentQualificationBindingV1,
    input: PreparedExecution,
    assertCurrent: () => void,
  ): Promise<EnvironmentQualificationEvidenceV1>;
};
const intent = 'qualify_then_code_once' as const;
const rootId = (podId: string, id: string) => `repair-${checkpointHash([podId, id]).slice(0, 48)}`;
const gitSha = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;

export function createRepairContinuation(deps: Dependencies) {
  const pods = deps.podRepo;
  const store = pods.retainedCoding ?? checkpointError('Repair storage unavailable');
  const checkpoints = pods.retainedCheckpoints ?? checkpointError('Retained custody unavailable');
  function staticSelection(podId: string) {
    const pod = pods.getOrThrow(podId);
    deps.assertPolicy(podId);
    checkpoints.assertAvailable(podId);
    const config = deps.readLaunch?.(podId) ?? checkpointError('Frozen launch required');
    if (
      config.intent !== 'task' ||
      config.workflow.agentMode !== 'auto' ||
      config.pim.length ||
      !pod.startCommitSha ||
      !gitSha.test(pod.startCommitSha) ||
      !pod.launchConfigDigest ||
      config.digest !== pod.launchConfigDigest ||
      config.requiredSidecarIds.length
    )
      checkpointError(
        'Only a settled frozen automatic task with pinned source/base and no startup PIM is supported',
      );
    if (
      !pod.finalization?.agentSettledAt ||
      !pod.finalization.sourcePreservedAt ||
      !pods.taskExecutions?.hasSettledRun?.(pod, pod.finalization.cycle)
    )
      checkpointError(
        'Positive original resource-bound worker settlement and preservation required',
      );
    assertValidationExecutionSettled(pod, pods.validationExecutions?.isSettled(pod));
    pods.validationExecutions?.assertTaskSettled(podId);
    for (const id of pods.sourceAdoptions?.taskPodIds(podId) ?? [podId])
      if (pods.sandboxWakeups?.listForPod(id).some((w) => w.endedAt === null))
        checkpointError('Unsettled wakeup requires reconciliation');
    const task =
      pods.taskExecutions?.snapshot(podId) ?? checkpointError('Task accounting unavailable');
    if (!['unlimited', 'below_recorded_limit'].includes(task.budgetCheck?.status ?? ''))
      checkpointError('Task budget unavailable or exhausted', 'REPAIR_BUDGET_BLOCKED');
    const profile = deps.executionForPod(pod);
    const retries = pods.workerRetries ?? checkpointError('Worker retry ledger unavailable');
    retries.preview(
      podId,
      pod.lifecycleGeneration,
      unavailableWorkerInputs,
      workerBindingHash({
        runtime: pod.runtime,
        model: pod.model,
        providerAccountId: profile.providerAccountId ?? null,
      }),
      [...WORKER_RETRY_BACKOFFS_MS],
      true,
    );
    const set = store.reports(podId, pod.lifecycleGeneration);
    const needs = inspectRepairPrerequisiteReports(set.reports, config, pod.lifecycleGeneration);
    if (needs.reportSetHash !== set.hash) checkpointError('Canonical report-set identity mismatch');
    const selection =
      deps.selection(podId) ?? checkpointError('Retained selection evidence unavailable');
    return { pod, config, task, needs, selection };
  }
  const refusal = (error: unknown) => {
    if (!(error instanceof AutopodError) || error.statusCode >= 500) throw error;
    const known: Record<string, RepairContinuationRefusalCode> = {
      REPAIR_UNSUPPORTED_NEEDS: 'unsupported_needs',
      REPAIR_EXECUTION_CONTEXT_UNSUPPORTED: 'unsupported_task',
      INVALID_PREREQUISITE_BLOCKER: 'unsupported_needs',
      REPAIR_INCOMPLETE_REPORTS: 'incomplete_reports',
      REPAIR_REPORTS_UNAVAILABLE: 'incomplete_reports',
      REPAIR_BUDGET_BLOCKED: 'budget_blocked',
      TASK_BUDGET_UNAVAILABLE: 'budget_blocked',
      TASK_BUDGET_EXHAUSTED: 'budget_blocked',
      UNCOLLECTED_HUMAN_GUIDANCE: 'uncollected_guidance',
      HUMAN_DECISION_PENDING: 'pending_decision',
      CHECKPOINT_RECOVERY_IN_PROGRESS: 'custody_held',
      CONTINUATION_SOURCE_HELD: 'custody_held',
      SOURCE_CUSTODY_HELD: 'custody_held',
      TASK_EXECUTION_UNSETTLED: 'execution_unsettled',
      TASK_EXECUTION_TERMINATION_UNVERIFIED: 'execution_unsettled',
      VALIDATION_EXECUTION_UNVERIFIED: 'execution_unsettled',
    };
    const code =
      known[error.code] ?? (error.code.startsWith('TASK_RETRY_') ? 'retry_blocked' : 'unavailable');
    return { code, message: error.message.slice(0, 1024) };
  };
  function display(config: EffectiveLaunchConfig) {
    return {
      target: config.execution.target,
      template: config.environment.template,
      imageKey: config.resolvedEnvironment.imageKey,
      platform: config.resolvedEnvironment.platform,
      memoryGb: config.resolvedExecution.main.memoryGb,
      cpus: config.resolvedExecution.main.cpus,
    };
  }
  async function preview(podId: string, query: RepairContinuationPreviewQueryV1) {
    try {
      const before = staticSelection(podId);
      const execution = await deps.previewExecution(podId, query.executionProfileId);
      const after = staticSelection(podId);
      if (configurationDigest(before) !== configurationDigest(after))
        checkpointError('Pod changed during preview');
      if (execution.target !== 'local')
        checkpointError('Only a reviewed local Docker replacement is supported');
      const replacement = retainedContinuationLaunch(after.config, podId, execution);
      if (!replacement.resolvedEnvironment.platform.startsWith('linux/'))
        checkpointError('Only Linux candidates are supported');
      const settings =
        deps.executionSettings?.(replacement) ??
        checkpointError('Replacement execution settings unavailable');
      assertQualificationExecutionContextSupported(settings);
      const inspect =
        deps.worktreeManager.inspectSourceAdoption ??
        checkpointError('Source inspection unavailable');
      const source = await inspect.call(
        deps.worktreeManager,
        after.pod.worktreePath!,
        after.pod.branch,
      );
      const current = staticSelection(podId);
      if (
        !source.worktreeClean ||
        source.commitSha !== query.sourceHead ||
        configurationDigest(after) !== configurationDigest(current)
      )
        checkpointError('Exact clean retained host source required');
      const expectedBindingDigest = configurationDigest({
        version: 1,
        podId,
        generation: after.pod.lifecycleGeneration,
        original: after.config.digest,
        replacement: replacement.digest,
        result: after.selection.expectedResultHash,
        reportSet: after.needs.reportSetHash,
        source,
        base: after.pod.startCommitSha,
        taskId: after.task.taskId,
        executionId: after.task.executionId,
        requirements: after.needs.requirementsHash,
      });
      return repairContinuationPreviewV1Schema.parse({
        version: 1,
        intent,
        podId,
        configurationOnly: true,
        actualQualification: 'not_run',
        conditionalAttemptEligible: true,
        selection: {
          expectedGeneration: after.selection.expectedGeneration,
          expectedResultHash: after.selection.expectedResultHash,
          expectedReportSetHash: after.needs.reportSetHash,
          sourceHead: source.commitSha,
          executionProfileId: query.executionProfileId,
          expectedExecutionDigest: replacement.digest,
          expectedBindingDigest,
          requirementsHash: after.needs.requirementsHash,
          target: 'local',
        },
        configurationDiff: { before: display(after.config), after: display(replacement) },
        refusals: [],
      });
    } catch (error) {
      return repairContinuationPreviewV1Schema.parse({
        version: 1,
        intent,
        podId,
        configurationOnly: true,
        actualQualification: 'not_run',
        conditionalAttemptEligible: false,
        selection: null,
        configurationDiff: null,
        refusals: [refusal(error)],
      });
    }
  }
  function operation(podId: string, requestId: string): RepairContinuationOperationV1 {
    const record = store.get(rootId(podId, requestId));
    if (!record || record.podId !== podId)
      throw new AutopodError('Repair request not found', 'REPAIR_REQUEST_NOT_FOUND', 404);
    const root = checkpoints.get(record.id) ?? checkpointError('Retained owner unavailable');
    const request = repairContinuationRequestV1Schema.parse(record.request);
    const facts = record.facts;
    const result = root.checked?.result;
    const interrupted =
      (!!facts.entered && facts.entered.processEpoch !== store.processEpoch) ||
      !!pods.taskExecutions?.hasUnverifiedTermination(podId) ||
      requiresValidationSettlement(pods.getOrThrow(podId)) ||
      !!pods.validationExecutions?.unsettled(podId) ||
      (!!root.blocked &&
        !!facts.entered &&
        (!facts.candidate || (!!facts.probing && !facts.qualified)));
    const blocked = !!root.blocked || !!facts.blocked;
    const final = facts.final_source;
    const qualification = facts.qualified?.evidence ?? null;
    const state = result
      ? result.overall === 'pass'
        ? 'validated'
        : 'failed'
      : interrupted
        ? 'unknown'
        : blocked
          ? 'failed'
          : root.checking
            ? 'checking'
            : final
              ? 'sealing'
              : facts.worker
                ? 'coding'
                : qualification
                  ? 'qualified'
                  : facts.probing
                    ? 'qualifying'
                    : facts.entered
                      ? 'provisioning'
                      : root.prepared
                        ? 'preparing'
                        : 'claimed';
    return repairContinuationOperationV1Schema.parse({
      operationId: record.id,
      version: 1,
      intent,
      podId,
      request,
      state,
      createdAt: record.createdAt,
      updatedAt: qualification?.finishedAt ?? record.createdAt,
      originalGeneration: root.generation,
      candidateGeneration: root.activated?.generation ?? null,
      qualification,
      codingFinalSource: final
        ? {
            version: 1,
            operationId: record.id,
            generation: final.generation,
            taskRunId: final.runId,
            selectedHead: final.inputHead,
            source: {
              repository: root.binding.repository,
              head: final.head,
              tree: final.tree,
              baseCommitSha: final.baseCommitSha,
            },
            clean: true,
            descendant: true,
            workerSettled: true,
            sealedAt: final.sealedAt,
            reportsHash: final.reportsHash,
          }
        : null,
      codingAdmission: facts.worker ? (interrupted ? 'unknown' : 'consumed') : 'not_admitted',
      checks: result
        ? result.overall === 'pass'
          ? 'passed'
          : 'failed'
        : root.checking
          ? interrupted
            ? 'unknown'
            : 'running'
          : 'not_started',
      refusals: blocked
        ? [
            {
              code: 'unavailable',
              message: (facts.blocked?.code ?? root.blocked?.code ?? 'Repair interrupted').slice(
                0,
                1024,
              ),
            },
          ]
        : [],
      originalResourcesRetained: true,
      requiresHumanApproval: true,
      publicationAuthorized: false,
    });
  }
  function inspect(podId: string) {
    const pod = pods.getOrThrow(podId);
    const record = store.latest(podId);
    const currentOperation = record
      ? operation(podId, repairContinuationRequestV1Schema.parse(record.request).id)
      : null;
    try {
      const selection = staticSelection(podId);
      return repairContinuationInspectionV1Schema.parse({
        version: 1,
        intent,
        podId,
        generation: pod.lifecycleGeneration,
        available: true,
        expectedResultHash: selection.selection.expectedResultHash,
        expectedReportSetHash: selection.needs.reportSetHash,
        sourceHead: null,
        requirementsHash: selection.needs.requirementsHash,
        operation: currentOperation,
        refusals: [],
      });
    } catch (error) {
      return repairContinuationInspectionV1Schema.parse({
        version: 1,
        intent,
        podId,
        generation: pod.lifecycleGeneration,
        available: false,
        expectedResultHash: null,
        expectedReportSetHash: null,
        sourceHead: null,
        requirementsHash: null,
        operation: currentOperation,
        refusals: [refusal(error)],
      });
    }
  }
  async function authorize(
    podId: string,
    input: RepairContinuationRequestV1,
    actor: OperatorActor,
  ) {
    const request = repairContinuationRequestV1Schema.parse(input);
    if (actor.type !== 'human' || !actor.userId.trim())
      checkpointError('Authenticated human required');
    const id = rootId(podId, request.id);
    const requestHash = store.requestHash(podId, request, actor);
    const prior = store.get(id);
    if (prior) {
      if (prior.requestHash !== requestHash)
        checkpointError(
          'Repair request conflicts with saved actor/content',
          'REPAIR_REQUEST_CONFLICT',
        );
      return operation(podId, request.id);
    }
    const selected = await preview(podId, {
      sourceHead: request.sourceHead,
      executionProfileId: request.executionProfileId,
    });
    const concurrent = store.get(id);
    if (concurrent) {
      if (concurrent.requestHash !== requestHash)
        checkpointError(
          'Repair request conflicts with saved actor/content',
          'REPAIR_REQUEST_CONFLICT',
        );
      return operation(podId, request.id);
    }
    const selection = selected.selection;
    if (!selected.conditionalAttemptEligible || !selection)
      checkpointError(selected.refusals[0]?.message ?? 'Conditional attempt unavailable');
    for (const key of [
      'expectedGeneration',
      'expectedResultHash',
      'expectedReportSetHash',
      'sourceHead',
      'executionProfileId',
      'expectedExecutionDigest',
      'expectedBindingDigest',
    ] as const)
      if (request[key] !== selection[key])
        checkpointError('Repair selection changed; preview again', 'REPAIR_SELECTION_STALE');
    const original = staticSelection(podId);
    const assertCurrent = () => {
      const current = staticSelection(podId);
      if (configurationDigest(current) !== configurationDigest(original))
        checkpointError('Original selection changed', 'REPAIR_SELECTION_STALE');
    };
    await deps.submitCoding(
      podId,
      {
        id,
        expectedGeneration: request.expectedGeneration,
        expectedResultHash: request.expectedResultHash,
        checkpointHead: request.sourceHead,
        executionProfileId: request.executionProfileId,
        expectedExecutionDigest: request.expectedExecutionDigest,
        reason: request.reason,
      },
      actor,
      {
        request,
        requestHash,
        binding: {
          version: 1,
          mode: 'qualify_then_code_once',
          reportSetHash: selection.expectedReportSetHash,
          requirementsHash: selection.requirementsHash,
          parentDigest: original.config.digest,
          executionDigest: selection.expectedExecutionDigest,
          bindingDigest: selection.expectedBindingDigest,
        },
        assertCurrent,
      },
    );
    return operation(podId, request.id);
  }
  function assertFence(podId: string) {
    const record = store.assertOwned(podId);
    const root = checkpoints.get(record.id) ?? checkpointError('Original custody missing');
    const pod = pods.getOrThrow(podId);
    deps.assertGuidanceCollected(podId);
    checkpoints.assertAvailable(podId);
    if (
      pod.status !== 'running' ||
      pod.pendingEscalation ||
      pods.hasUnansweredDecision?.(podId) ||
      pods.hasInfrastructureBlocker?.(podId) ||
      pod.launchConfigDigest !== record.binding.executionDigest ||
      store.reports(podId, root.generation).hash !== record.binding.reportSetHash
    )
      checkpointError(
        'Coding selection/report/decision ownership changed',
        'REPAIR_SELECTION_STALE',
      );
    return record;
  }
  async function assertCandidateCurrent(podId: string, requireQualified = true) {
    const record = requireQualified ? store.assertQualified(podId, true) : store.assertOwned(podId);
    assertFence(podId);
    const root = checkpoints.get(record.id) ?? checkpointError('Original custody missing');
    const pod = pods.getOrThrow(podId);
    checkpoints.assertAvailable(podId);
    deps.assertGuidanceCollected(podId);
    if (
      pod.pendingEscalation ||
      pods.hasUnansweredDecision?.(podId) ||
      pods.hasInfrastructureBlocker?.(podId)
    )
      checkpointError('New human work or infrastructure need blocks dispatch');
    if (
      store.reports(podId, root.generation).hash !== record.binding.reportSetHash ||
      pod.launchConfigDigest !== record.binding.executionDigest
    )
      checkpointError('Reports or configuration changed');
    const candidate = record.facts.candidate ?? checkpointError('Candidate identity missing');
    const cm = deps.getContainerManager('local');
    const key = await cm.getResourceKey?.(candidate.containerId);
    assertFence(podId);
    if (requireQualified && key !== record.facts.qualified?.evidence.binding.resourceKey)
      checkpointError('Qualified resource identity changed');
    if (!key || (await cm.getStatus(candidate.containerId)) !== 'running')
      checkpointError('Candidate is not the observed running resource');
    assertFence(podId);
    const metadata = await cm.getExecutionMetadata?.(candidate.containerId);
    assertFence(podId);
    if (metadata?.imageDigest !== candidate.expectedImage)
      checkpointError('Candidate image identity changed');
    const source = await deps.worktreeManager.inspectSourceAdoption!(pod.worktreePath!, pod.branch);
    assertFence(podId);
    if (
      !source.worktreeClean ||
      source.commitSha !== root.prepared?.head ||
      source.treeSha !== root.prepared.tree
    )
      checkpointError('Candidate source changed before dispatch');
    if (requireQualified) {
      const proof = store.assertQualified(podId, true).facts.qualified!.evidence;
      const profile = deps.executionForPod(pod);
      const requirements = pod.contract?.executionRequirements;
      const currentLaunch =
        deps.readLaunch?.(podId) ?? checkpointError('Frozen candidate unavailable');
      const memory = Math.max(
        (profile.containerMemoryGb ?? DEFAULT_CONTAINER_MEMORY_GB) * 1024 ** 3,
        requirements?.minimumMemoryBytes ?? 0,
      );
      const cpus = Math.max(
        currentLaunch.resolvedExecution.main.cpus ?? 0,
        requirements?.minimumCpu ?? 0,
      );
      if (
        !Number.isSafeInteger(metadata.memoryLimitBytes) ||
        (metadata.memoryLimitBytes ?? 0) < memory ||
        cm.supportsStreamingExec !== true ||
        (cpus > 0 &&
          (!Number.isFinite(metadata.cpuLimit ?? NaN) || (metadata.cpuLimit ?? 0) < cpus))
      )
        checkpointError('Qualified resource bounds changed or became unknown');
      if (qualificationExecutionContextHash(profile) !== proof.binding.executionContextHash)
        checkpointError('Qualified execution context changed');
      const observed = await cm.execInContainer(
        candidate.containerId,
        [
          '/usr/local/bin/node',
          '-e',
          QUALIFICATION_SOURCE_PROBE,
          proof.binding.source.baseCommitSha,
        ],
        {
          cwd: profile.buildWorkDir ? `/workspace/${profile.buildWorkDir}` : '/workspace',
          env: profile.buildEnv ?? {},
          user: 'autopod',
          timeout: 10000,
          assertCurrent: () => {
            assertFence(podId);
          },
        },
      );
      assertFence(podId);
      store.assertQualified(podId, true);
      if (observed.exitCode !== 0 || Buffer.byteLength(observed.stdout) > 65536)
        checkpointError('Actual candidate source fence is unknown');
      const actual: unknown = JSON.parse(observed.stdout);
      if (
        !actual ||
        typeof actual !== 'object' ||
        !('head' in actual) ||
        actual.head !== proof.binding.source.head ||
        !('tree' in actual) ||
        actual.tree !== proof.binding.source.tree ||
        !('clean' in actual) ||
        actual.clean !== true ||
        !('baseAncestor' in actual) ||
        actual.baseAncestor !== true ||
        !('uid' in actual) ||
        actual.uid !== 1000 ||
        !('platform' in actual) ||
        actual.platform !== proof.binding.platform ||
        !('cwd' in actual) ||
        actual.cwd !== (profile.buildWorkDir ? `/workspace/${profile.buildWorkDir}` : '/workspace')
      )
        checkpointError('Actual candidate source/context changed after qualification');
      const finalMetadata = await cm.getExecutionMetadata?.(candidate.containerId);
      assertFence(podId);
      if (
        !finalMetadata ||
        finalMetadata.imageDigest !== metadata.imageDigest ||
        finalMetadata.memoryLimitBytes !== metadata.memoryLimitBytes ||
        finalMetadata.cpuLimit !== metadata.cpuLimit ||
        finalMetadata.networkMode !== metadata.networkMode
      )
        checkpointError('Candidate metadata changed during consumption');
      const finalKey = await cm.getResourceKey?.(candidate.containerId);
      assertFence(podId);
      store.assertQualified(podId, true);
      if (
        proof.binding.resourceKey !== finalKey ||
        proof.binding.reportSetHash !== store.reports(podId, root.generation).hash ||
        proof.binding.replacementLaunchDigest !== pods.getOrThrow(podId).launchConfigDigest
      )
        checkpointError('Qualification binding changed');
    }
    return { record, root, pod, resourceKey: key };
  }
  async function qualify(input: PreparedExecution) {
    if (!store.isOwner(input.pod.id)) return;
    const { record, root, pod, resourceKey } = await assertCandidateCurrent(input.pod.id, false);
    const candidate = record.facts.candidate!;
    const config = input.launchConfig ?? checkpointError('Frozen candidate missing');
    const task = pods.taskExecutions!.snapshot(pod.id);
    const source = {
      repository: root.binding.repository,
      head: root.prepared!.head,
      tree: root.prepared!.tree,
      baseCommitSha: root.prepared!.baseCommitSha!,
    };
    const binding: EnvironmentQualificationBindingV1 = {
      version: 1,
      operationId: record.id,
      requestHash: record.requestHash,
      podId: pod.id,
      taskId: task.taskId,
      executionId: task.executionId,
      custodyId: root.id,
      originalGeneration: root.generation,
      candidateGeneration: pod.lifecycleGeneration,
      originalResultHash: root.binding.resultHash,
      reportSetHash: record.binding.reportSetHash,
      requirementsHash: record.binding.requirementsHash,
      originalLaunchDigest: record.binding.parentDigest,
      replacementLaunchDigest: config.digest,
      configurationHash: configurationDigest(config),
      sourceEpoch: configurationDigest(source),
      credentialEpoch: configurationDigest(record.id),
      resourceEpoch: configurationDigest([store.processEpoch, resourceKey, candidate.containerId]),
      source,
      target: 'local',
      containerId: candidate.containerId,
      resourceKey,
      expectedImage: { kind: 'docker-image-id', digest: candidate.expectedImage },
      platform: config.resolvedEnvironment.platform as 'linux/amd64' | 'linux/arm64',
      executionContextHash: qualificationExecutionContextHash(input.profile),
    };
    store.append(record.id, 'probing', { processEpoch: store.processEpoch });
    const evidence = await deps.qualify(binding, input, () => {
      assertFence(pod.id);
    });
    await assertCandidateCurrent(pod.id, false);
    store.append(record.id, 'qualified', {
      processEpoch: store.processEpoch,
      expiresAt: evidence.expiresAt,
      evidence,
    });
    if (evidence.outcome !== 'qualified' || evidence.bindingDigest !== configurationDigest(binding))
      checkpointError('Actual candidate did not qualify', 'REPAIR_QUALIFICATION_FAILED');
  }
  return { inspect, preview, authorize, operation, qualify, assertCandidateCurrent, assertFence };
}
export type RepairContinuation = ReturnType<typeof createRepairContinuation>;
