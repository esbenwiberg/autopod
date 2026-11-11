import { cp, lstat, mkdir, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type {
  ArtifactChecksRecoveryRequest,
  EffectiveLaunchConfig,
  OperatorActor,
  Pod,
  ValidationResult,
} from '@autopod/shared';
import { configurationDigest } from '../configuration/configuration-digest.js';
import type { ContainerManager } from '../interfaces/container-manager.js';
import type { PodExecutionSettings } from '../interfaces/pod-execution-settings.js';
import {
  type ArtifactChecksBinding,
  type ArtifactChecksRecord,
  artifactChecksError,
  withArtifactChecksReview,
} from './artifact-checks-recovery-repository.js';
import { collectArtifactSnapshot } from './artifact-preservation.js';
import {
  fingerprintArtifactSnapshot,
  verifyArtifactSnapshot,
} from './artifact-snapshot-receipt.js';
import type { PodRepository } from './pod-repository.js';
import { inspectRepairPrerequisiteReports } from './prerequisite-blocker.js';
import { getPodValidationSkipPhases } from './validation-workflow-policy.js';

/** Full text artifact contents expressed as additions, with no Git baseline/commit claim.
 * Reject unsupported contents rather than silently reviewing a partial/empty packet.
 */
export async function artifactReviewContents(root: string): Promise<string> {
  const parts = [
    'Artifact contents (complete source snapshot; not a Git diff or Git provenance).\n',
  ];
  let bytes = 0;
  let files = 0;
  async function visit(relative: string) {
    const file = path.join(root, relative);
    const stat = await lstat(file);
    if (stat.isDirectory()) {
      for (const name of (await readdir(file)).sort()) await visit(path.join(relative, name));
      return;
    }
    if (!stat.isFile() || stat.size > 500_000 || /[\r\n"\\]/.test(relative))
      artifactChecksError(
        'Initial artifact review supports bounded regular UTF-8 source files only',
      );
    const raw = await readFile(file);
    if (!/^[A-Za-z0-9_.+@/-]+$/.test(relative))
      artifactChecksError('Artifact path cannot be represented unambiguously in a review packet');
    const content = new TextDecoder('utf-8', { fatal: true }).decode(raw);
    if (content.includes('\0')) artifactChecksError('Binary artifact review is unsupported');
    bytes += raw.length + Buffer.byteLength(relative) + 100;
    if (bytes > 500_000 || ++files > 1000)
      artifactChecksError('Complete artifact review exceeds supported packet bounds');
    const lines = content.split('\n');
    parts.push(
      `diff --git a/${relative} b/${relative}\n--- /dev/null\n+++ b/${relative}\n@@ -0,0 +1,${lines.length} @@\n${lines.map((line) => `+${line}`).join('\n')}\n`,
    );
  }
  await visit('');
  if (!files) artifactChecksError('Artifact source is empty');
  return parts.join('\n');
}

interface Dependencies {
  podRepo: PodRepository;
  readLaunch(podId: string): EffectiveLaunchConfig | null;
  executionForPod(pod: Pod): PodExecutionSettings;
  cm(): ContainerManager;
  isIdle(podId: string): boolean;
  assertGuidanceCollected(podId: string): void;
  root: string;
  /** Production adapter provisions/qualifies only; no runtime or correction worker. */
  execute(input: {
    pod: Pod;
    launch: EffectiveLaunchConfig;
    snapshot: string;
    workspace: string;
    diff: string;
    operationId: string;
    sourceHash: string;
    assertCurrent(): Pod;
    record(kind: string, evidence: unknown): void;
  }): Promise<ValidationResult>;
}

export function createArtifactChecksRecovery(deps: Dependencies) {
  const { podRepo: pods } = deps;
  const store = pods.artifactChecks ?? artifactChecksError('Artifact checks ledger unavailable');
  const pending = new Map<string, Promise<void>>();
  function selection(podId: string, owned = false) {
    const pod = pods.getOrThrow(podId);
    const launch = deps.readLaunch(podId);
    const profile = deps.executionForPod(pod);
    if (
      !launch ||
      launch.digest !== pod.launchConfigDigest ||
      launch.intent !== 'task' ||
      launch.repository ||
      launch.references.length ||
      launch.ai.reviewer.mode !== 'independent' ||
      launch.workflow.agentMode !== 'auto' ||
      launch.pim.length ||
      launch.requiredSidecarIds.length ||
      launch.work.inputBundle ||
      pod.linkedPodId ||
      pod.requireSidecars.length ||
      pod.options.output !== 'artifact' ||
      pod.completionPolicy === 'accept-findings' ||
      pod.executionTarget !== 'local' ||
      pod.status !== 'failed' ||
      !pod.containerId ||
      pod.worktreePath ||
      pod.lastValidationResult ||
      pod.worktreeCompromised ||
      pod.finalization?.generation !== pod.lifecycleGeneration ||
      pod.finalization.phase !== 'ready' ||
      !pod.finalization.agentSettledAt ||
      pod.finalization.sourcePreservedAt ||
      pod.finalization.pendingDecisionId ||
      pod.pendingEscalation ||
      pods.hasUnansweredDecision?.(podId) ||
      !pods.hasInfrastructureBlocker?.(podId) ||
      pod.skipValidation ||
      pod.validationWaiver ||
      pod.validationOverrides?.length ||
      pod.options.validate === false ||
      pod.options.validationSuite === 'thin' ||
      pod.taskSummary?.factDeviations?.length ||
      pod.options.validationSuite === 'off' ||
      (pod.sidecarContainerIds && Object.keys(pod.sidecarContainerIds).length) ||
      profile.hasWebUi !== false ||
      profile.privateRegistries.length ||
      pod.referenceRepos?.length ||
      !pod.contract?.requiredFacts.length ||
      !['complete', 'repaired'].includes(pod.tokenTelemetryAccuracy) ||
      pod.contract.requiredFacts.some(
        (f) =>
          !f.command.trim() ||
          f.kind === 'browser-test' ||
          !['create', 'touch'].includes(f.artifact.change),
      ) ||
      getPodValidationSkipPhases(profile, pod).some((p) => ['facts', 'review'].includes(p))
    )
      artifactChecksError(
        'Requires a frozen standalone non-web local artifact task, settled ready worker, executable Facts, independent review and no waivers or external inputs',
      );
    if (!deps.isIdle(podId) || !pods.taskExecutions?.hasSettledRun?.(pod, pod.finalization.cycle))
      artifactChecksError('Positive exact-resource worker settlement and idle execution required');
    pods.recoveryForks?.assertOriginalAvailable(podId);
    pods.recoveryForks?.assertTaskExecutionAllowed(podId);
    pods.taskExecutions.assertCanDelete(podId);
    if (!owned) pods.validationExecutions?.assertNoActiveTaskExecution(podId);
    pods.validationExecutions?.assertTaskSettled(podId);
    pods.deletionOwnership?.assertTaskAvailable(podId);
    pods.retainedFinalizations?.assertAvailable(podId);
    pods.stalledRecoveries?.assertAvailable(podId);
    if (!owned) pods.sourceAdoptions?.assertAvailable(podId);
    if (pods.sourceAdoptions?.hasCustody(podId) || pods.retainedCheckpoints?.latest(podId))
      artifactChecksError('Another source recovery owns this task');
    pods.sourceAdoptions?.assertControlPlaneSettled(podId);
    deps.assertGuidanceCollected(podId);
    const task = pods.taskExecutions.snapshot(podId);
    if (task.budgetCheck?.status !== 'unlimited' || task.podCount !== 1)
      artifactChecksError(
        'Complete standalone task accounting and available frozen budget required',
      );
    const reports =
      pods.retainedCoding?.reports(podId, pod.lifecycleGeneration) ??
      artifactChecksError('Complete prerequisite report set unavailable');
    const needs = inspectRepairPrerequisiteReports(
      reports.reports,
      launch,
      pod.lifecycleGeneration,
    );
    return { pod, launch, profile, task, needs };
  }
  async function binding(podId: string, owned = false): Promise<ArtifactChecksBinding> {
    const selected = selection(podId, owned);
    const cm = deps.cm();
    if (!cm.getResourceKey || !cm.getExecutionMetadata)
      artifactChecksError('Exact Docker provider identity unavailable');
    const resourceKey = await cm.getResourceKey(selected.pod.containerId!);
    const metadata = await cm.getExecutionMetadata(selected.pod.containerId!);
    if (metadata.workspaceStorage !== 'container' || (metadata.podId && metadata.podId !== podId))
      artifactChecksError(
        'Original workspace must be positively observed private container storage',
      );
    pods.validationExecutions?.assertResourceUnshared(podId, selected.pod.containerId!);
    const current = selection(podId, owned);
    if (configurationDigest(current) !== configurationDigest(selected))
      artifactChecksError('Selection changed during observation');
    if (!resourceKey) artifactChecksError('Original Docker resource identity unavailable');
    return {
      podId,
      taskId: selected.task.taskId,
      generation: selected.pod.lifecycleGeneration,
      cycle: selected.pod.finalization!.cycle,
      containerId: selected.pod.containerId!,
      resourceKey,
      reportsHash: selected.needs.reportSetHash,
      authorityHash: configurationDigest([
        selected.launch,
        selected.profile,
        selected.pod.task,
        selected.pod.contract,
        selected.pod.options,
        selected.pod.providerIdSnapshot,
        selected.pod.providerAccountIdSnapshot,
        selected.task.tokenBudget,
        selected.pod.inputTokens,
        selected.pod.outputTokens,
        selected.pod.tokenTelemetryAccuracy,
        selected.pod.finalization,
        selected.pod.taskSummary,
        selected.pod.plan,
      ]),
    };
  }
  async function inspect(podId: string) {
    const operation = store.forPod(podId);
    try {
      const selected = await binding(podId, Boolean(operation));
      return {
        operation,
        selection: { binding: selected, expectedBindingHash: configurationDigest(selected) },
        source: 'Not captured or qualified until explicit selection',
        refusal: null,
      };
    } catch (error) {
      return {
        operation,
        selection: null,
        refusal: error instanceof Error ? error.message : String(error),
      };
    }
  }
  function assertCurrent(record: ArtifactChecksRecord): Pod {
    if (store.get(record.id)?.events.blocked)
      artifactChecksError('Recovery is blocked; no further mutations are admitted');
    const current = selection(record.binding.podId, true);
    if (
      current.pod.lifecycleGeneration !== record.binding.generation ||
      current.pod.containerId !== record.binding.containerId ||
      current.pod.finalization!.cycle !== record.binding.cycle ||
      current.task.taskId !== record.binding.taskId ||
      current.needs.reportSetHash !== record.binding.reportsHash ||
      configurationDigest([
        current.launch,
        current.profile,
        current.pod.task,
        current.pod.contract,
        current.pod.options,
        current.pod.providerIdSnapshot,
        current.pod.providerAccountIdSnapshot,
        current.task.tokenBudget,
        current.pod.inputTokens,
        current.pod.outputTokens,
        current.pod.tokenTelemetryAccuracy,
        current.pod.finalization,
        current.pod.taskSummary,
        current.pod.plan,
      ]) !== record.binding.authorityHash
    )
      artifactChecksError(
        'Admitted authority, resource, task, source cycle or prerequisite reports changed',
      );
    return current.pod;
  }
  async function run(record: ArtifactChecksRecord) {
    const cm = deps.cm();
    const id = record.id;
    const events = () => store.get(id)!.events;
    const append = (kind: string, evidence: unknown) => store.append(id, kind, evidence);
    const current = () => assertCurrent(record);
    if (
      events().checked ||
      events().blocked ||
      events().captureDispatched ||
      events().executionDispatched
    )
      return;
    if ((await cm.getResourceKey!(record.binding.containerId)) !== record.binding.resourceKey)
      artifactChecksError('Original resource identity changed');
    current();
    let status = await cm.getStatus(record.binding.containerId);
    current();
    if (!events().stopDispatched && status === 'running') {
      append('stopDispatched', { resourceKey: record.binding.resourceKey });
      try {
        await store.stop(id, () => cm.stop(record.binding.containerId));
      } catch {
        return;
      }
      status = await cm.getStatus(record.binding.containerId);
      current();
    }
    if (status !== 'stopped') return; // Reconciliation observes; never repeat a stop.
    current();
    if (!events().stopped) append('stopped', { observedAt: new Date().toISOString() });
    append('captureDispatched', { containerId: record.binding.containerId });
    try {
      const root = path.join(deps.root, id);
      append('storage', { root });
      const snapshot = await store.stop(id, () =>
        collectArtifactSnapshot({
          containerManager: cm,
          containerId: record.binding.containerId,
          artifactRoot: root,
          generation: record.binding.generation,
          cycle: record.binding.cycle,
          isCurrent: () => {
            current();
            return true;
          },
        }),
      );
      const inventory = await fingerprintArtifactSnapshot(snapshot);
      const diff = await artifactReviewContents(snapshot);
      current();
      if (
        (await cm.getStatus(record.binding.containerId)) !== 'stopped' ||
        (await cm.getResourceKey!(record.binding.containerId)) !== record.binding.resourceKey
      )
        artifactChecksError('Original changed during capture');
      append('captured', { snapshot, inventory, reviewHash: configurationDigest(diff) });
      const workspace = path.join(root, 'execution');
      await mkdir(workspace, { recursive: false });
      await cp(snapshot, workspace, { recursive: true, preserveTimestamps: true });
      if ((await fingerprintArtifactSnapshot(workspace)).sha256 !== inventory.sha256)
        artifactChecksError('Independent workspace differs from captured source');
      await verifyArtifactSnapshot(
        snapshot,
        root,
        record.binding.generation,
        record.binding.cycle,
        inventory.sha256,
      );
      current();
      append('executionDispatched', { sourceHash: inventory.sha256 });
      const { pod, launch } = selection(record.binding.podId, true);
      const result = await store.execute(id, () =>
        withArtifactChecksReview(current, () =>
          deps.execute({
            pod,
            launch,
            snapshot,
            workspace,
            diff,
            operationId: id,
            sourceHash: inventory.sha256,
            assertCurrent: current,
            record: append,
          }),
        ),
      );
      append('result', {
        result,
        sourceHash: inventory.sha256,
        resultHash: configurationDigest(result),
      });
      await verifyArtifactSnapshot(
        snapshot,
        root,
        record.binding.generation,
        record.binding.cycle,
        inventory.sha256,
      );
      current();
      const passed =
        result.podId === pod.id &&
        result.attempt === pod.validationAttempts + 1 &&
        result.overall === 'pass' &&
        !result.infrastructureFailure &&
        result.taskReview?.status === 'pass' &&
        result.factValidation?.status === 'pass' &&
        result.taskReview.diff === diff &&
        (!deps.executionForPod(pod).buildCommand || result.smoke.build.status === 'pass') &&
        pod.contract!.requiredFacts.every((fact) =>
          result.factValidation!.results.some(
            (r) =>
              r.factId === fact.id &&
              r.command === fact.command &&
              r.artifactPath === fact.artifact.path &&
              r.status === 'pass' &&
              r.passed &&
              r.exitCode === 0,
          ),
        );
      append('checked', {
        outcome: passed ? 'pass' : 'non-passing',
        sourceHash: inventory.sha256,
        resultHash: configurationDigest(result),
        originalRetained: true,
      });
    } catch (error) {
      if (!events().blocked)
        append('blocked', { message: error instanceof Error ? error.message : String(error) });
    }
  }
  async function submit(
    podId: string,
    input: ArtifactChecksRecoveryRequest,
    actor: OperatorActor,
    reconcile = false,
  ) {
    if (
      actor.type !== 'human' ||
      !actor.userId.trim() ||
      !/^[A-Za-z0-9-]{1,64}$/.test(input.id) ||
      !/^[a-f0-9]{64}$/.test(input.expectedBindingHash) ||
      input.reason.trim().length < 10 ||
      input.reason.length > 4000
    )
      artifactChecksError(
        'Authenticated human, stable exact selection and meaningful reason required',
      );
    const requestHash = configurationDigest([podId, input, actor]);
    let record = store.get(input.id);
    if (record) {
      if (record.binding.podId !== podId || record.requestHash !== requestHash)
        artifactChecksError('Request identity conflicts with saved actor/selection');
    } else {
      if (reconcile)
        artifactChecksError(
          'No saved request exists to reconcile; inspect before explicit selection',
        );
      const selected = await binding(podId);
      if (configurationDigest(selected) !== input.expectedBindingHash)
        artifactChecksError('Inspected selection is stale');
      record = store.admit(
        input.id,
        selected,
        requestHash,
        () => {
          selection(podId);
        },
        { actor, request: input },
      );
    }
    if (!pending.has(input.id)) {
      const saved = record;
      const operation = Promise.resolve()
        .then(() => run(saved))
        .catch((error) => {
          if (!store.get(saved.id)!.events.blocked)
            store.append(saved.id, 'blocked', {
              message: error instanceof Error ? error.message : String(error),
            });
        })
        .finally(() => pending.delete(input.id));
      pending.set(input.id, operation);
    }
    return store.get(input.id)!;
  }
  return { inspect, submit, wait: (id: string) => pending.get(id) ?? Promise.resolve() };
}
