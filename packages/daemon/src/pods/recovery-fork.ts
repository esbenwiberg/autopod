import { randomUUID } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  AutopodError,
  type EffectiveLaunchConfig,
  type EnvironmentQualificationBindingV1,
  generatePodId,
  type OperatorActor,
  outputModeFromPodOptions,
  type Pod,
  type RecoveryForkBudget,
  type RecoveryForkInput,
  type RecoveryForkInspection,
  type RecoveryForkOperation,
  type RecoveryForkPreview,
  type RecoveryForkRequest,
  recoveryForkInputSchema,
  recoveryForkRequestSchema,
} from '@autopod/shared';
import { configurationDigest } from '../configuration/configuration-digest.js';
import { launchPodOptions } from '../configuration/launch-pod-options.js';
import {
  RECOVERY_FORK_HANDOFF_PATH,
  recoveryForkLaunch,
} from '../configuration/recovery-fork-launch.js';
import {
  type RetainedExecutionSelection,
  retainedContinuationLaunch,
} from '../configuration/retained-continuation-launch.js';
import type { ContainerManager } from '../interfaces/container-manager.js';
import type { PodExecutionSettings } from '../interfaces/pod-execution-settings.js';
import { RECOVERY_FILE_LIMITS } from '../interfaces/recovery-files.js';
import type { WorktreeManager } from '../interfaces/worktree-manager.js';
import {
  inspectRecoveryForkFiles,
  prepareRecoveryForkSource,
  recoveryBytesHash,
  recoveryGit,
} from '../worktrees/recovery-fork-source.js';
import { assertCheckpointRepository } from '../worktrees/retained-checkpoint-workspace.js';
import { inspectSupplementalAdoptionGit } from '../worktrees/source-adoption-git.js';
import {
  assertQualificationExecutionContextSupported,
  QUALIFICATION_SOURCE_PROBE,
  qualificationExecutionContextHash,
  qualifyExecutionEnvironment,
} from './environment-qualification.js';
import type { EventRepository } from './event-repository.js';
import type { PodManagerDependencies } from './pod-manager-contracts.js';
import type { PodRepository } from './pod-repository.js';
import { assertRepairableExecutionRequirements } from './prerequisite-blocker.js';
import type { PreparedExecution } from './provisioning-ports.js';
import { recoveryForkContext } from './recovery-fork-context.js';
import {
  RecoveryForkRejectedBeforeClaim,
  RecoveryForkSelectionError,
} from './recovery-fork-rejection.js';
import {
  recoveryForkError as fail,
  type RecoveryForkBinding,
  type RecoveryForkRecord,
  recoveryForkProcessEpoch,
} from './recovery-fork-repository.js';
import { finalizationSourceLocations } from './retained-finalization-repository.js';
import { assertValidationExecutionSettled } from './validation-recovery-policy.js';
import { isDockerValidationResourceKey } from './validation-resource-scope.js';
import {
  unavailableWorkerInputs,
  WORKER_RETRY_BACKOFFS_MS,
  workerBindingHash,
} from './worker-retry-history.js';

function configHasRecoveryPointer(config: EffectiveLaunchConfig | null) {
  return (
    config?.derivation?.kind === 'recovery-fork' ||
    !!config?.work.handoffInstructions?.includes(RECOVERY_FORK_HANDOFF_PATH)
  );
}

type Launch = NonNullable<PodManagerDependencies['launchConfiguration']>;
export function createRecoveryFork(deps: {
  pods: PodRepository;
  launch?: Launch;
  events?: EventRepository;
  worktrees: WorktreeManager;
  container(target: Pod['executionTarget']): ContainerManager;
  settings(pod: Pod): PodExecutionSettings;
  assertGuidanceCollected(podId: string): void;
  isIdle(podId: string): boolean;
  isGoal(podId: string): boolean;
  enqueue(podId: string): void;
  created?(pod: Pod): void;
  root: string;
}) {
  const pods = deps.pods;
  const store = pods.recoveryForks ?? fail('Recovery storage unavailable');
  const launch = () => deps.launch ?? fail('Frozen launch configuration unavailable');
  const events = () => deps.events ?? fail('Visible event history unavailable');
  function accounting(pod: Pod) {
    const task = pods.taskExecutions?.snapshot(pod.id) ?? fail('Task accounting unavailable');
    if (!['unlimited', 'below_recorded_limit'].includes(task.budgetCheck?.status ?? ''))
      fail('Task budget unavailable or exhausted', 'RECOVERY_FORK_BUDGET_BLOCKED');
    pods.taskExecutions!.assertCanDelete(pod.id);
    const retry = pods.workerRetries ?? fail('Worker retry ledger unavailable');
    const preview = retry.preview(
      pod.id,
      pod.lifecycleGeneration,
      unavailableWorkerInputs,
      workerBindingHash({
        runtime: pod.runtime,
        model: pod.model,
        providerAccountId: deps.settings(pod).providerAccountId ?? null,
      }),
      [...WORKER_RETRY_BACKOFFS_MS],
      true,
    );
    if (preview.authorizationAvailable)
      fail(
        'Original-pod retry authorization cannot be granted to a new recovery execution',
        'RECOVERY_FORK_RETRY_BLOCKED',
      );
    return task;
  }
  function budget(pod: Pod): RecoveryForkBudget {
    const task = pods.taskExecutions?.snapshot(pod.id) ?? fail('Task accounting unavailable');
    let retryAuthorizationRequired: boolean | null = null;
    try {
      accounting(pod);
      retryAuthorizationRequired = false;
    } catch (error) {
      if (error instanceof AutopodError && error.code.startsWith('TASK_RETRY_'))
        retryAuthorizationRequired = true;
    }
    return {
      taskId: task.taskId,
      status: task.budgetCheck?.status ?? 'unavailable',
      tokenBudget: task.tokenBudget,
      recordedTokens: task.recordedTotalTokens ?? null,
      retryAuthorizationRequired,
    };
  }
  function policy(podId: string, owned = false) {
    const pod = pods.getOrThrow(podId);
    (
      launch().assertRecoveryAdmissionReady ??
      fail('Recovery admission readiness evidence unavailable')
    )();
    if (store.child(podId) || configHasRecoveryPointer(launch().read(podId)))
      fail(
        'Chained recovery handoffs are unsupported; retain the server-owned prior packet',
        'RECOVERY_FORK_CHAIN_UNSUPPORTED',
      );
    if (!pods.hasUnansweredDecision) fail('Durable human-decision evidence unavailable');
    if (!owned) store.assertOriginalAvailable(podId);
    const config = launch().read(podId) ?? fail('Original frozen task launch required');
    if (
      config.intent !== 'task' ||
      deps.isGoal(podId) ||
      config.workflow.agentMode !== 'auto' ||
      pod.options.agentMode !== 'auto' ||
      !['failed', 'review_required'].includes(pod.status) ||
      !['pr', 'branch'].includes(config.workflow.output) ||
      !config.workflow.validationPhases.length ||
      !config.repository ||
      config.digest !== pod.launchConfigDigest ||
      !pod.startCommitSha ||
      !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(pod.startCommitSha) ||
      !pod.worktreePath ||
      pod.worktreeCompromised ||
      !pod.containerId ||
      !['local', 'sandbox'].includes(pod.executionTarget) ||
      pod.executionTarget !== config.execution.target ||
      pod.pendingEscalation ||
      pods.hasUnansweredDecision?.(podId) ||
      pod.skipValidation ||
      pod.validationWaiver ||
      (pod.validationOverrides?.length ?? 0) ||
      pod.linkedPodId ||
      pod.prUrl ||
      pod.seriesId ||
      config.pim.length ||
      pod.requireSidecars.length ||
      Object.keys(pod.sidecarContainerIds ?? {}).length ||
      config.requiredSidecarIds.length ||
      Object.keys(config.resolvedExecution.sidecars).length
    )
      fail(
        'Only settled ordinary automatic tasks with frozen source, enabled checks and no decisions, waivers, sidecars, PIM or delivery are supported',
      );
    if (
      ![
        pod.prFixAttempts,
        pod.maxPrFixAttempts,
        pod.validationAttempts,
        pod.maxValidationAttempts,
      ].every((value) => Number.isSafeInteger(value) && value >= 0)
    )
      fail('Unsupported original retry allowance; recovery cannot infer or reset counters');
    // The normal independent reviewer is frozen, not an inherited historical pass.
    if (
      config.ai.reviewer.mode !== 'independent' ||
      !config.workflow.validationPhases.includes('review')
    )
      fail('Frozen enabled independent review route required');
    if (
      pod.validationAttempts >=
      Math.min(pod.maxValidationAttempts, config.workflow.maxValidationAttempts)
    )
      fail('Original validation allowance is exhausted; recovery does not reset attempts');
    if (config.work.contract?.executionRequirements !== undefined)
      assertRepairableExecutionRequirements(config.work.contract.executionRequirements);
    assertCheckpointRepository(config.repository.config.remote);
    if (
      !pod.finalization?.agentSettledAt ||
      !pod.finalization.sourcePreservedAt ||
      !pods.taskExecutions?.hasSettledRun?.(pod, pod.finalization.cycle)
    )
      fail('Positive exact original worker settlement and preserved host source required');
    deps.assertGuidanceCollected(podId);
    if (
      !pods.validationExecutions ||
      !pods.deletionOwnership ||
      !pods.sourceAdoptions ||
      !pods.sandboxWakeups ||
      !pods.retainedCheckpoints ||
      !pods.retainedFinalizations ||
      !pods.stalledRecoveries
    )
      fail('Owning custody/settlement ledgers unavailable');
    assertValidationExecutionSettled(pod, pods.validationExecutions.isSettled(pod));
    pods.validationExecutions.assertTaskSettled(podId);
    pods.validationExecutions.assertNoPendingRecovery(podId);
    pods.validationExecutions.assertResourceUnshared(podId, pod.containerId);
    if (pods.validationExecutions.hasGoal(podId))
      fail('Native Goal state cannot be adopted as an ordinary recovery fork');
    store.assertUnsharedSource(podId, pod.worktreePath);
    pods.deletionOwnership.assertTaskAvailable(podId);
    if (!owned) {
      pods.retainedCheckpoints.assertAvailable(podId);
      pods.retainedFinalizations.assertAvailable(podId);
      pods.stalledRecoveries.assertAvailable(podId);
    }
    if (
      pods.retainedCheckpoints.latest(podId) ||
      pods.approvalRewrites?.latest(pod) ||
      pods.sourceAdoptions.hasCustody(podId)
    )
      fail('Existing source/checkpoint/rewrite custody must be observed through its owner');
    for (const id of pods.sourceAdoptions.taskPodIds(podId)) {
      const ownChild = owned && store.child(id)?.parentPodId === podId;
      if (
        (!ownChild && !deps.isIdle(id)) ||
        pods.sandboxWakeups.listForPod(id).some((w) => w.endedAt === null)
      )
        fail('Original task invocation or wakeup is unsettled');
    }
    const task = accounting(pod);
    store.assertNoDeliveryCustody(task.taskId);
    return { pod, config, task };
  }
  async function resource(pod: Pod) {
    const cm = deps.container(pod.executionTarget);
    if (!cm.getResourceKey) fail('Exact original resource identity unavailable');
    const key = await cm.getResourceKey(pod.containerId!);
    if (
      !(pod.executionTarget === 'local'
        ? isDockerValidationResourceKey(key, pod.containerId!)
        : !!cm.executionResourceScope &&
          /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(pod.containerId!) &&
          key.startsWith('https://') &&
          key.endsWith(`/sandboxes/${pod.containerId}`)) ||
      (await cm.getStatus(pod.containerId!)) !== 'stopped' ||
      (await cm.getResourceKey(pod.containerId!)) !== key
    )
      fail('Original resource must be the exact observed stopped instance');
    return key;
  }
  function operation(record: RecoveryForkRecord): RecoveryForkOperation {
    const f = record.facts;
    const interrupted =
      (record.processEpoch !== recoveryForkProcessEpoch && !f.admitted) ||
      (!!f.entered &&
        f.entered.processEpoch !== recoveryForkProcessEpoch &&
        (!f.admitted || !store.workerSettled(f.admitted.childPodId)));
    const child = f.admitted
      ? (pods.getForHistory ?? pods.getOrThrow)(f.admitted.childPodId)
      : null;
    return {
      version: 1,
      id: record.requestId,
      parentPodId: record.parentPodId,
      generation: record.binding.generation,
      actorId: record.actorId,
      request: record.request,
      state:
        f.unknown || interrupted
          ? 'unknown'
          : f.failed
            ? 'failed'
            : child && f.worker && ['failed', 'review_required'].includes(child.status)
              ? 'failed'
              : f.qualified
                ? f.qualified.evidence.outcome === 'qualified'
                  ? 'qualified'
                  : f.qualified.evidence.outcome === 'unknown'
                    ? 'unknown'
                    : 'failed'
                : f.probing
                  ? 'qualifying'
                  : f.admitted
                    ? 'queued'
                    : 'preparing',
      childPodId: f.admitted?.childPodId ?? null,
      childStatus: child?.status ?? null,
      sourceHead: record.binding.source.head,
      copiedFiles: f.prepared?.files.map((f) => f.path) ?? [],
      context: record.binding.context,
      error:
        f.unknown?.code ??
        f.failed?.code ??
        (f.qualified && f.qualified.evidence.outcome !== 'qualified'
          ? 'RECOVERY_FORK_QUALIFICATION_UNVERIFIED'
          : null) ??
        (child && f.worker && ['failed', 'review_required'].includes(child.status)
          ? 'RECOVERY_FORK_CHILD_FAILED'
          : null) ??
        (interrupted
          ? 'Recovery attempt interrupted; original custody retained. No step was replayed.'
          : null),
      createdAt: record.createdAt,
    };
  }
  async function inspect(podId: string, strict = false): Promise<RecoveryForkInspection> {
    const pod = (pods.getForHistory ?? pods.getOrThrow)(podId);
    const prior = store.parent(podId);
    const lineage = store.child(podId);
    const context = recoveryForkContext(pod, events());
    let source: RecoveryForkInspection['source'] = null;
    let currentBudget: RecoveryForkBudget | null = null;
    const blockers: string[] = [];
    try {
      currentBudget = budget(pod);
    } catch {
      blockers.push('Task budget/retry evidence unavailable');
    }
    try {
      const before = policy(podId);
      const inspectSource =
        deps.worktrees.inspectSourceAdoption ?? fail('Read-only host source inspector unavailable');
      const observed = await inspectSource.call(deps.worktrees, pod.worktreePath!, pod.branch, {
        allowSupplementalFiles: true,
      });
      if (!observed.worktreeClean) fail('Clean exact host checkpoint required');
      const listing = await inspectRecoveryForkFiles(pod.worktreePath!);
      try {
        await recoveryGit(pod.worktreePath!)([
          'merge-base',
          '--is-ancestor',
          pod.startCommitSha!,
          observed.commitSha,
        ]);
      } catch {
        fail('Original task base must be a locally verified ancestor of the host checkpoint');
      }
      const key = await resource(pod);
      const after = policy(podId);
      if (
        !key ||
        configurationDigest(before) !== configurationDigest(after) ||
        configurationDigest(context) !==
          configurationDigest(recoveryForkContext(after.pod, events()))
      )
        fail('Original source/context/accounting changed during inspection');
      source = {
        head: observed.commitSha,
        tree: observed.treeSha,
        baseCommitSha: pod.startCommitSha!,
        branch: pod.branch,
        repository: before.config.repository!.config.remote,
        ...listing,
        caveats: [
          'HOST checkpoint only; final sandbox source and reports are not certified.',
          'Only selected safe nonignored supplemental files are copied. Ignored, unavailable, dependency, credential and unselected files remain in original custody.',
          'Preview is conditional configuration evidence; actual replacement qualification has not run.',
        ],
      };
    } catch (error) {
      if (strict || !(error instanceof AutopodError) || error.statusCode >= 500) throw error;
      blockers.push(error.message);
    }
    return {
      version: 1,
      podId,
      generation: pod.lifecycleGeneration,
      available: blockers.length === 0,
      blockers,
      source,
      context,
      budget: currentBudget,
      profiles: [
        { id: '@original', label: 'Original frozen environment' },
        ...(deps.launch?.availableRecoveryProfiles?.() ?? []),
      ],
      operation: prior ? operation(prior) : null,
      lineage: lineage
        ? { parentPodId: lineage.parentPodId, operationId: lineage.requestId }
        : null,
    };
  }
  async function resolve(podId: string, input: RecoveryForkInput) {
    const view = await inspect(podId, true);
    if (!view.available || !view.source) fail(view.blockers[0] ?? 'Recovery unavailable');
    const selected = policy(podId);
    if (input.expectedGeneration !== view.generation || input.sourceHead !== view.source.head)
      fail(
        'Generation/host checkpoint changed; inspect and preview again',
        'RECOVERY_FORK_SELECTION_STALE',
      );
    for (const file of input.files)
      if (!view.source.files.some((f) => f.path === file.path && f.version === file.version))
        fail('Supplemental file selection changed', 'RECOVERY_FORK_SELECTION_STALE');
    if (
      input.files.reduce(
        (sum, file) => sum + (view.source!.files.find((f) => f.path === file.path)?.size ?? 0),
        0,
      ) > RECOVERY_FILE_LIMITS.maxSelectionBytes
    )
      fail('Selected supplemental files exceed 50 MiB');
    const original = selected.config;
    let selection: RetainedExecutionSelection;
    if (input.executionProfileId === '@original') {
      selection = {
        profileId: '@original',
        parentDigest: original.digest,
        environment: structuredClone(original.environment),
        resolvedEnvironment: structuredClone(original.resolvedEnvironment),
        target: original.execution.target,
        main: structuredClone(original.resolvedExecution.main),
        resolvedExecution: structuredClone(original.resolvedExecution),
        digest: '',
      };
      selection.digest = retainedContinuationLaunch(original, podId, selection).digest;
    } else
      selection = await (launch().previewRetainedExecution?.(podId, input.executionProfileId, {
        readOnly: true,
      }) ?? fail('Reviewed execution-profile preview unavailable'));
    if (selection.target !== 'local')
      fail('Only Linux local Docker recovery candidates can currently be qualified');
    const execution = recoveryForkLaunch(original, podId, selection, input);
    const settings = launch().executionSettings(execution);
    assertQualificationExecutionContextSupported(settings);
    await launch().assertCurrentCapabilities(execution);
    const after = policy(podId);
    if (
      configurationDigest(selected) !== configurationDigest(after) ||
      configurationDigest(view.context) !==
        configurationDigest(recoveryForkContext(after.pod, events()))
    )
      fail('Original task/settings/context changed', 'RECOVERY_FORK_SELECTION_STALE');
    const binding: RecoveryForkBinding = {
      version: 1,
      parentPodId: podId,
      parentHash: configurationDigest(selected.pod),
      generation: view.generation,
      taskId: selected.task.taskId,
      originalLaunch: original,
      selection,
      execution,
      settingsHash: configurationDigest(settings),
      source: view.source,
      worktreePath: selected.pod.worktreePath!,
      sourceLocations: finalizationSourceLocations([selected.pod.worktreePath!]),
      archiveRoot: deps.root,
      containerId: selected.pod.containerId!,
      resourceKey: await resource(selected.pod),
      resourceScope: deps.container(selected.pod.executionTarget).executionResourceScope ?? null,
      context: view.context,
      contextHash: configurationDigest(view.context),
      accountingHash: configurationDigest(selected.task),
    };
    if (configurationDigest(after) !== configurationDigest(policy(podId)))
      fail('Original task changed', 'RECOVERY_FORK_SELECTION_STALE');
    return { view, binding };
  }
  async function preview(podId: string, raw: RecoveryForkInput): Promise<RecoveryForkPreview> {
    const input = recoveryForkInputSchema.parse(raw);
    try {
      const { view, binding } = await resolve(podId, input);
      const config = binding.execution;
      return {
        version: 1,
        podId,
        generation: view.generation,
        available: true,
        blockers: [],
        expectedBinding: configurationDigest({ binding, input }),
        source: view.source,
        context: view.context,
        budget: view.budget,
        execution: {
          profileId: input.executionProfileId,
          target: config.execution.target,
          template: config.environment.template,
          platform: config.resolvedEnvironment.platform,
          memoryGb: config.resolvedExecution.main.memoryGb,
          cpus: config.resolvedExecution.main.cpus,
          originalTemplate: binding.originalLaunch.environment.template,
          sameEnvironment:
            config.resolvedEnvironment.imageKey ===
              binding.originalLaunch.resolvedEnvironment.imageKey &&
            configurationDigest(config.resolvedExecution) ===
              configurationDigest(binding.originalLaunch.resolvedExecution),
        },
        input,
      };
    } catch (error) {
      if (!(error instanceof AutopodError) || error.statusCode >= 500) throw error;
      const view = await inspect(podId);
      return {
        version: 1,
        podId,
        generation: view.generation,
        available: false,
        blockers: [error.message],
        expectedBinding: null,
        source: view.source,
        context: view.context,
        budget: view.budget,
        execution: null,
        input,
      };
    }
  }
  function assertCurrent(record: RecoveryForkRecord, beforeAdmission = false) {
    const current = policy(record.parentPodId, true);
    if (
      configurationDigest(current.pod) !== record.binding.parentHash ||
      (deps.container(current.pod.executionTarget).executionResourceScope ?? null) !==
        record.binding.resourceScope ||
      current.config.digest !== record.binding.originalLaunch.digest ||
      configurationDigest(recoveryForkContext(current.pod, events())) !==
        record.binding.contextHash ||
      (beforeAdmission && configurationDigest(current.task) !== record.binding.accountingHash) ||
      configurationDigest(launch().executionSettings(record.binding.execution)) !==
        record.binding.settingsHash
    )
      fail(
        'Frozen original context/configuration/accounting changed',
        'RECOVERY_FORK_SELECTION_STALE',
      );
  }
  async function create(
    podId: string,
    raw: RecoveryForkRequest,
    actor: OperatorActor,
  ): Promise<RecoveryForkOperation> {
    const request = recoveryForkRequestSchema.parse(raw);
    if (actor.type !== 'human' || !actor.userId.trim())
      throw new AutopodError('Authenticated human required', 'UNAUTHORIZED', 401);
    const replay = () => {
      const previous = store.parent(podId);
      if (!previous) return null;
      if (
        previous.requestHash !==
        configurationDigest({ parentPodId: podId, request, actorId: actor.userId })
      )
        fail(
          'Recovery request ID/payload/actor conflicts with saved operation',
          'RECOVERY_FORK_REQUEST_CONFLICT',
        );
      return operation(previous);
    };
    const previous = replay();
    if (previous) return previous;
    const { id: _, expectedBinding: __, ...input } = request;
    let binding: RecoveryForkBinding;
    try {
      ({ binding } = await resolve(podId, input));
      // Resolve awaits policy/resource/profile reads. Recheck raw source and
      // forbidden metadata after those waits, before the first claim attempt.
      const finalFiles = await inspectRecoveryForkFiles(binding.worktreePath);
      const finalSource = await inspectSupplementalAdoptionGit(
        recoveryGit(binding.worktreePath),
        binding.source.branch,
      );
      if (
        finalSource.head !== binding.source.head ||
        finalSource.tree !== binding.source.tree ||
        input.files.some(
          (file) =>
            !finalFiles.files.some(
              (current) => current.path === file.path && current.version === file.version,
            ),
        )
      )
        fail('Host source changed before claim', 'RECOVERY_FORK_SELECTION_STALE');
      const raced = replay();
      if (raced) return raced;
      if (request.expectedBinding !== configurationDigest({ binding, input }))
        fail('Preview binding is stale; preview again', 'RECOVERY_FORK_SELECTION_STALE');
    } catch (error) {
      // No claim has been attempted. Confirm custody again in the same synchronous
      // turn; a racing owner, replay or conflicting request must remain retained.
      const raced = replay();
      if (raced) return raced;
      store.assertOriginalAvailable(podId);
      const pod = pods.getOrThrow(podId);
      store.assertUnsharedSource(podId, pod.worktreePath ?? '');
      store.assertTaskExecutionAllowed(podId);
      if (
        !pods.sourceAdoptions ||
        !pods.retainedCheckpoints ||
        !pods.retainedFinalizations ||
        !pods.stalledRecoveries ||
        !pods.deletionOwnership ||
        !pods.approvalRewrites ||
        store.child(podId)
      )
        throw error;
      pods.sourceAdoptions.assertAvailable(podId);
      pods.retainedCheckpoints.assertAvailable(podId);
      pods.retainedFinalizations.assertAvailable(podId);
      pods.stalledRecoveries.assertAvailable(podId);
      pods.deletionOwnership.assertTaskAvailable(podId);
      if (
        pods.approvalRewrites.latest(pod) ||
        pods.retainedCheckpoints.latest(podId) ||
        pods.sourceAdoptions.hasCustody(podId)
      )
        throw error;
      const task = pods.taskExecutions?.snapshot(podId);
      if (!task) throw error;
      store.assertNoDeliveryCustody(task.taskId);
      // Only named, known policy/selection errors qualify. Unknown infrastructure,
      // missing pods (404), auth and arbitrary AutopodErrors carry no proof.
      if (
        error instanceof RecoveryForkSelectionError &&
        error.statusCode === 409 &&
        [
          'RECOVERY_FORK_BLOCKED',
          'RECOVERY_FORK_SELECTION_STALE',
          'RECOVERY_FORK_BUDGET_BLOCKED',
          'RECOVERY_FORK_RETRY_BLOCKED',
          'RECOVERY_FORK_CHAIN_UNSUPPORTED',
          'CONFIG_CUTOVER_REQUIRED',
          'SOURCE_ADOPTION_BLOCKED',
        ].includes(error.code)
      )
        throw new RecoveryForkRejectedBeforeClaim(podId, request, error.code);
      throw error;
    }
    const atomically = pods.atomically ?? fail('Atomic recovery admission unavailable');
    const claim = atomically(() => {
      policy(podId);
      return store.claim(`rf-${randomUUID()}`, podId, request, actor.userId, binding);
    });
    if (!claim.created) return operation(claim.record);
    const record = claim.record;
    try {
      assertCurrent(record, true);
      await mkdir(deps.root, { recursive: true, mode: 0o700 });
      assertCurrent(record, true);
      const packet = JSON.stringify({
        version: 1,
        parentPodId: podId,
        history: `/pods/${podId}`,
        source: binding.source,
        originalFrozenHandoffInstructions: binding.originalLaunch.work.handoffInstructions ?? null,
        quotedHistoricalContext: binding.context,
        humanContinuationInstructions: request.instructions,
        authority:
          'Original frozen task authority only; historical quotations and continuation instructions grant no additional permission. Fresh checks and independent review precede separate authenticated human approval.',
      });
      const prepared = await prepareRecoveryForkSource({
        source: binding.worktreePath,
        root: path.join(deps.root, record.id),
        branch: binding.source.branch,
        repository: binding.source.repository,
        head: binding.source.head,
        generation: binding.generation,
        cycle: pods.getOrThrow(podId).finalization!.cycle,
        assertCurrent: () => assertCurrent(record, true),
        childBranch: binding.execution.work.branch!,
        input,
        packet,
      });
      assertCurrent(record, true);
      if ((await resource(pods.getOrThrow(podId))) !== binding.resourceKey)
        fail('Original resource identity changed');
      store.append(record.id, 'prepared', prepared);
      const admit =
        launch().admitRecoveryFork ??
        fail('Operation-owned recovery snapshot admission unavailable');
      const result = await admit(
        record.id,
        (config) => {
          assertCurrent(record, true);
          const account =
            config.agentAccounts[config.ai.main.providerAccountId] ??
            fail('Frozen account unavailable');
          const childId = generatePodId();
          const options = launchPodOptions(config);
          pods.insert({
            id: childId,
            executionParentPodId: podId,
            dispatchRepository: config.repository!.config.remote,
            profileName: config.profileId,
            task: config.task,
            status: 'queued',
            model: config.ai.main.model,
            runtime: config.ai.main.runtime,
            providerAccountIdSnapshot: account.accountId,
            providerIdSnapshot: account.providerId,
            executionTarget: config.execution.target,
            branch: prepared.branch,
            userId: actor.userId,
            maxValidationAttempts: config.workflow.maxValidationAttempts,
            skipValidation: false,
            contract: config.work.contract,
            options,
            outputMode: outputModeFromPodOptions(options),
            baseBranch: config.work.baseBranch,
            tokenBudget: pods.taskExecutions!.snapshot(podId).tokenBudget,
            autoApprove: false,
            disableAskHuman: false,
            handoffInstructions: config.work.handoffInstructions,
            specContextFiles: config.work.specContextFiles,
            inputBundle: config.work.inputBundle,
          });
          return childId;
        },
        (childId, config) => {
          const original = pods.getOrThrow(podId);
          pods.update(childId, {
            worktreePath: prepared.worktree,
            recoveryWorktreePath: prepared.worktree,
            startCommitSha: binding.source.baseCommitSha,
            handoffContext: config.work.handoffInstructions ?? null,
            prFixAttempts: original.prFixAttempts,
            maxPrFixAttempts: original.maxPrFixAttempts,
            validationAttempts: original.validationAttempts,
            maxValidationAttempts: Math.min(
              original.maxValidationAttempts,
              config.workflow.maxValidationAttempts,
            ),
          });
        },
      );
      // This callback follows the complete snapshot + child + operation transaction.
      if (result.created) {
        deps.created?.(pods.getOrThrow(result.podId));
        deps.enqueue(result.podId);
      }
    } catch (error) {
      // Retain all original and private evidence. Never retry an uncertain preparation/admission.
      const current = store.get(record.id)!;
      if (!current.facts.failed && !current.facts.unknown)
        store.append(record.id, error instanceof AutopodError ? 'failed' : 'unknown', {
          code: error instanceof AutopodError ? error.code : 'RECOVERY_FORK_PREPARATION_FAILED',
        });
      throw error;
    }
    return operation(store.get(record.id)!);
  }
  async function process<T>(podId: string, run: () => Promise<T>): Promise<T> {
    const record = store.child(podId);
    if (!record) return run();
    if (record.facts.entered || record.facts.failed || record.facts.unknown)
      fail(
        'Recovery provisioning already entered or interrupted; observe operation without replay',
      );
    try {
      assertCurrent(record);
    } catch (error) {
      store.append(record.id, error instanceof AutopodError ? 'failed' : 'unknown', {
        code: error instanceof AutopodError ? error.code : 'RECOVERY_FORK_PREFLIGHT_UNCERTAIN',
      });
      throw error;
    }
    store.append(record.id, 'entered', { processEpoch: recoveryForkProcessEpoch });
    try {
      const result = await run();
      const current = store.get(record.id)!;
      if (!current.facts.qualified && !current.facts.failed && !current.facts.unknown)
        store.append(record.id, 'unknown', { code: 'RECOVERY_FORK_PROVISIONING_DID_NOT_QUALIFY' });
      return result;
    } catch (error) {
      const current = store.get(record.id)!;
      if (!current.facts.failed && !current.facts.unknown)
        store.append(record.id, 'unknown', { code: 'RECOVERY_FORK_PROVISIONING_UNCERTAIN' });
      throw error;
    }
  }
  async function qualifyCandidate(input: PreparedExecution) {
    const record = store.child(input.pod.id);
    if (!record) return;
    const prepared = record.facts.prepared ?? fail('Prepared recovery source unavailable');
    const assertChild = () => {
      assertCurrent(record);
      const current = store.child(input.pod.id)!;
      const pod = pods.getOrThrow(input.pod.id);
      if (
        current.facts.failed ||
        current.facts.unknown ||
        current.facts.entered?.processEpoch !== recoveryForkProcessEpoch ||
        current.facts.worker ||
        pod.lifecycleGeneration !== input.pod.lifecycleGeneration ||
        pod.containerId !== input.containerId ||
        pod.worktreePath !== prepared.worktree ||
        pod.launchConfigDigest !== record.binding.execution.digest ||
        pod.pendingEscalation ||
        pods.hasUnansweredDecision?.(pod.id)
      )
        fail('Recovery child ownership changed');
      accounting(pod);
    };
    assertChild();
    if (record.facts.probing || record.facts.qualified)
      fail('Qualification already entered; no replay');
    const packet = await readFile(prepared.packet, 'utf8');
    assertChild();
    if (recoveryBytesHash(packet) !== prepared.packetHash)
      fail('Immutable handoff packet unavailable');
    if (
      recoveryBytesHash(
        await input.containerManager.readFile(input.containerId, RECOVERY_FORK_HANDOFF_PATH),
      ) !== prepared.packetHash
    )
      fail('Handoff packet verification failed');
    assertChild();
    const cm = input.containerManager;
    if (!cm.getResourceKey || !cm.getExecutionMetadata)
      fail('Exact candidate metadata unavailable');
    const key = await cm.getResourceKey(input.containerId);
    const metadata = await cm.getExecutionMetadata(input.containerId);
    assertChild();
    const candidate =
      record.facts.candidate ?? fail('Prepared candidate image reservation unavailable');
    if (
      !key ||
      !metadata.imageDigest ||
      candidate.containerId !== input.containerId ||
      metadata.imageDigest !== candidate.expectedImage ||
      !/^sha256:[a-f0-9]{64}$/.test(metadata.imageDigest) ||
      key === record.binding.resourceKey
    )
      fail('Independent exact candidate resource/image required');
    const task = pods.taskExecutions!.snapshot(input.pod.id);
    const source = {
      repository: record.binding.source.repository,
      head: prepared.head,
      tree: prepared.tree,
      baseCommitSha: record.binding.source.baseCommitSha,
    };
    const binding: EnvironmentQualificationBindingV1 = {
      version: 1,
      operationId: record.id,
      requestHash: record.requestHash,
      podId: input.pod.id,
      taskId: task.taskId,
      executionId: task.executionId,
      custodyId: record.id,
      originalGeneration: record.binding.generation,
      candidateGeneration: input.pod.lifecycleGeneration,
      originalResultHash: record.binding.parentHash,
      reportSetHash: record.binding.contextHash,
      requirementsHash: configurationDigest(
        record.binding.originalLaunch.work.contract?.executionRequirements ?? null,
      ),
      originalLaunchDigest: record.binding.originalLaunch.digest,
      replacementLaunchDigest: record.binding.execution.digest,
      configurationHash: configurationDigest(record.binding.execution),
      sourceEpoch: configurationDigest({
        source,
        files: prepared.files,
        packet: prepared.packetHash,
      }),
      credentialEpoch: configurationDigest(record.binding.execution.credentialReferences),
      resourceEpoch: configurationDigest({ process: recoveryForkProcessEpoch, key }),
      source,
      target: 'local',
      containerId: input.containerId,
      resourceKey: key,
      expectedImage: { kind: 'docker-image-id', digest: metadata.imageDigest },
      platform: record.binding.execution.resolvedEnvironment.platform as
        | 'linux/amd64'
        | 'linux/arm64',
      executionContextHash: qualificationExecutionContextHash(input.profile),
      recoveryFork: {
        parentPodId: record.parentPodId,
        contextHash: record.binding.contextHash,
        packetHash: prepared.packetHash,
        filesHash: configurationDigest(prepared.files),
      },
    };
    store.append(record.id, 'probing', {
      processEpoch: recoveryForkProcessEpoch,
      containerId: input.containerId,
      resourceKey: key,
    });
    const result = await qualifyExecutionEnvironment({
      binding,
      pod: input.pod,
      profile: input.profile,
      launchConfig: input.launchConfig!,
      containerManager: cm,
      preparationCompleted: true,
      assertCurrent: assertChild,
      recoveryFork: { files: prepared.files, packetHash: prepared.packetHash },
    });
    assertChild();
    store.append(record.id, 'qualified', {
      processEpoch: recoveryForkProcessEpoch,
      evidence: result.evidence,
      expiresAt: result.evidence.expiresAt,
    });
    if (result.provenance)
      pods.executionProvenance?.record(
        input.pod.id,
        input.pod.lifecycleGeneration,
        result.provenance,
      );
    if (result.evidence.outcome !== 'qualified')
      fail(
        'Actual recovery candidate did not qualify; coding is blocked',
        'RECOVERY_FORK_QUALIFICATION_FAILED',
      );
  }
  async function assertConsumptionCurrent(podId: string) {
    const record = store.assertBoundWorker(podId);
    const prepared = record.facts.prepared!;
    const proof = record.facts.qualified!.evidence;
    const pod = pods.getOrThrow(podId);
    const settings = deps.settings(pod);
    const assertFrozen = () => {
      store.assertBoundWorker(podId);
      const original = pods.getOrThrow(record.parentPodId);
      deps.assertGuidanceCollected(original.id);
      if (
        configurationDigest(original) !== record.binding.parentHash ||
        configurationDigest(recoveryForkContext(original, events())) !==
          record.binding.contextHash ||
        launch().read(original.id)?.digest !== record.binding.originalLaunch.digest ||
        launch().read(podId)?.digest !== record.binding.execution.digest ||
        qualificationExecutionContextHash(settings) !== proof.binding.executionContextHash
      )
        fail('Recovery consumption source/context/settings changed');
    };
    assertFrozen();
    const cm = deps.container('local');
    if (!cm.getResourceKey || !cm.getExecutionMetadata)
      fail('Exact recovery execution fence unavailable');
    const metadata = await cm.getExecutionMetadata(pod.containerId!);
    const key = await cm.getResourceKey(pod.containerId!);
    assertFrozen();
    if (
      key !== proof.binding.resourceKey ||
      metadata.imageDigest !== proof.binding.expectedImage.digest ||
      (await cm.getStatus(pod.containerId!)) !== 'running' ||
      (metadata.memoryLimitBytes ?? 0) <
        record.binding.execution.resolvedExecution.main.memoryGb * 1024 ** 3 ||
      (record.binding.execution.resolvedExecution.main.cpus !== null &&
        (metadata.cpuLimit ?? 0) < record.binding.execution.resolvedExecution.main.cpus)
    )
      fail('Qualified recovery resource changed');
    const observed = await cm.execInContainer(
      pod.containerId!,
      [
        '/usr/local/bin/node',
        '-e',
        QUALIFICATION_SOURCE_PROBE,
        proof.binding.source.baseCommitSha,
        JSON.stringify({ files: prepared.files, packetHash: prepared.packetHash }),
      ],
      {
        cwd: settings.buildWorkDir ? `/workspace/${settings.buildWorkDir}` : '/workspace',
        env: settings.buildEnv ?? {},
        user: 'autopod',
        timeout: 10_000,
        maxOutputBytes: 65536,
        assertCurrent: assertFrozen,
      },
    );
    assertFrozen();
    if (observed.exitCode !== 0 || Buffer.byteLength(observed.stdout) > 65536)
      fail('Actual recovery source/context fence is unknown');
    const actual = JSON.parse(observed.stdout);
    if (
      actual.head !== prepared.head ||
      actual.tree !== prepared.tree ||
      actual.clean !== true ||
      actual.baseAncestor !== true ||
      actual.uid !== 1000 ||
      actual.platform !== proof.binding.platform ||
      actual.cwd !== (settings.buildWorkDir ? `/workspace/${settings.buildWorkDir}` : '/workspace')
    )
      fail('Actual recovery source/context changed after qualification');
    const after = await cm.getExecutionMetadata(pod.containerId!);
    if (
      configurationDigest(metadata) !== configurationDigest(after) ||
      (await cm.getResourceKey(pod.containerId!)) !== key
    )
      fail('Recovery resource changed during consumption');
    assertFrozen();
  }
  return {
    inspect,
    preview,
    create,
    process,
    async qualifyChild(input: PreparedExecution) {
      const record = store.child(input.pod.id);
      if (!record) return;
      try {
        await qualifyCandidate(input);
      } catch (error) {
        const current = store.get(record.id)!;
        if (!current.facts.qualified && !current.facts.failed && !current.facts.unknown)
          store.append(record.id, error instanceof AutopodError ? 'failed' : 'unknown', {
            code:
              error instanceof AutopodError ? error.code : 'RECOVERY_FORK_QUALIFICATION_UNCERTAIN',
          });
        throw error;
      }
    },
    assertConsumptionCurrent,
    get(podId: string, requestId: string) {
      const record = store.parent(podId);
      if (!record || record.requestId !== requestId)
        throw new AutopodError('Recovery operation not found', 'RECOVERY_FORK_NOT_FOUND', 404);
      return operation(record);
    },
  };
}
