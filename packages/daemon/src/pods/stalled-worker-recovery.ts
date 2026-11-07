import { realpathSync, statSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import type {
  OperatorActor,
  Pod,
  StalledWorkerRecoveryReceipt,
  StalledWorkerRecoveryRequest,
  StalledWorkerRecoveryView,
} from '@autopod/shared';
import type { ContainerManager } from '../interfaces/container-manager.js';
import type { WorktreeManager } from '../interfaces/worktree-manager.js';
import { fingerprintPreservedWorkspace } from './artifact-snapshot-receipt.js';
import type { PodRepository } from './pod-repository.js';
import {
  type StalledRecord,
  stalledError,
  stalledHash,
} from './stalled-worker-recovery-repository.js';
import { assertValidationMutationSettled } from './validation-recovery-policy.js';
import { WORKSPACE_SYNC_EXCLUDES } from './workspace-mirror.js';

/** Docker only: stopped Docker tasks have exited; suspended sandboxes have not. */
export function createStalledWorkerRecovery(deps: {
  podRepo: PodRepository;
  getContainerManager(): ContainerManager;
  worktreeManager: WorktreeManager;
  isIdle(podId: string): boolean;
  isGoal(podId: string): boolean;
  assertGuidanceCollected(podId: string): void;
  preserveWorkspace(pod: Pod): Promise<void>;
  transition(pod: Pod, status: 'failed'): void;
  emit(podId: string, message: string): void;
  root: string;
}) {
  const pods = deps.podRepo;
  const journal = pods.stalledRecoveries ?? stalledError('Stalled worker journal unavailable.');
  const pending = new Map<
    string,
    { hash: string; promise: Promise<StalledWorkerRecoveryReceipt> }
  >();
  const identity = (pod: Pod) => {
    if (!pod.worktreePath) return null;
    const stat = statSync(pod.worktreePath);
    if (!stat.isDirectory()) stalledError('Original worktree is not a directory.');
    return [realpathSync(pod.worktreePath), stat.dev, stat.ino];
  };
  function selection(podId: string) {
    const pod = pods.getOrThrow(podId);
    const runs = journal.unsettled(podId);
    const reports = journal.reports(podId);
    const fingerprint = stalledHash([
      pod.id,
      pod.lifecycleGeneration,
      pod.status,
      pod.containerId,
      pod.executionTarget,
      pod.worktreePath,
      identity(pod),
      pod.branch,
      pod.baseBranch,
      pod.launchConfigDigest,
      pod.profileSnapshot,
      pod.options,
      pod.contract,
      pod.worktreeCompromised,
      pod.pendingEscalation,
      pod.failureReason,
      pod.lastValidationResult,
      pod.preSubmitReview,
      pod.sidecarContainerIds,
      pod.requireSidecars,
      pod.finalization,
      reports,
      runs,
    ]);
    return { pod, runs, reports, fingerprint };
  }
  function policy(podId: string) {
    const s = selection(podId),
      { pod, runs } = s;
    if (
      !['running', 'failed'].includes(pod.status) ||
      pod.executionTarget !== 'local' ||
      pod.options.agentMode === 'interactive' ||
      deps.isGoal(podId)
    )
      stalledError(
        'Only blocked ordinary local Docker tasks support stop-and-retain; interactive and native Goal controls remain separate.',
      );
    if (
      !pods.hasInfrastructureBlocker?.(podId) &&
      !(
        pod.lastRecoveryTrigger &&
        pod.lastCorrectionMessage &&
        pod.lastValidationResult?.overall === 'fail'
      )
    )
      stalledError('No recorded infrastructure/restart blocker requires stalled-worker recovery.');
    if (
      !pods.taskExecutions ||
      !pods.validationExecutions ||
      !pods.sourceAdoptions ||
      !pods.deletionOwnership ||
      !pods.atomically
    )
      stalledError('Exact execution and custody evidence is unavailable.');
    if (
      runs.length !== 1 ||
      runs[0]!.podId !== podId ||
      runs[0]!.generation !== pod.lifecycleGeneration
    )
      stalledError(
        'One exact unsettled run in the current lifecycle is required. Inspect other task owners separately.',
      );
    const run = runs[0]!;
    if (!pods.completionJournal || pod.finalization?.cycle !== run.cycle)
      stalledError(
        'Exact original completion cycle is unavailable; no settlement can be inferred.',
      );
    let binding: {
      version?: number;
      resource?: { containerId?: string; executionTarget?: string };
    };
    try {
      binding = JSON.parse(run.binding);
    } catch {
      return stalledError('Dispatch-recorded resource binding is invalid.');
    }
    const resource = binding.resource;
    if (
      binding.version !== 2 ||
      resource?.executionTarget !== 'local' ||
      !resource.containerId ||
      !/^[a-f0-9]{64}$/.test(resource.containerId) ||
      resource.containerId !== pod.containerId
    )
      stalledError(
        'A dispatch-recorded full Docker ID matching this lifecycle is required; names, mutable guesses and legacy missing identity are unsupported.',
      );
    if (
      !pod.worktreePath ||
      pod.worktreeCompromised ||
      (!pod.launchConfigDigest && !pod.profileSnapshot)
    )
      stalledError('Retained worktree and frozen execution configuration are required.');
    if (pod.pendingEscalation || journal.hasPendingDecision(podId))
      stalledError(
        'Resolve the existing human decision through its owning control before recovery.',
      );
    if (pod.requireSidecars.length || Object.keys(pod.sidecarContainerIds ?? {}).length)
      stalledError('Sidecar/shared-resource recovery is not supported by this control.');
    pods.retainedFinalizations?.assertAvailable(podId);
    pods.retainedCheckpoints?.assertAvailable(podId);
    if (pods.retainedCheckpoints?.latest(podId) || pods.approvalRewrites?.latest(pod))
      stalledError(
        'Retained continuation or approval rewrite owns this source; use its existing control.',
      );
    if (pods.sourceAdoptions.hasCustody(podId)) stalledError('Source adoption owns this task.');
    pods.deletionOwnership.assertTaskAvailable(podId);
    journal.assertOtherAdmissionsSettled(podId, run.id);
    pods.validationExecutions.assertResourceUnshared(podId, resource.containerId);
    pods.validationExecutions.assertNoPendingRecovery(podId);
    assertValidationMutationSettled(pods, podId);
    pods.sandboxWakeups?.assertReleasable(resource.containerId);
    for (const id of new Set([podId, ...pods.sourceAdoptions.taskPodIds(podId)]))
      if (!deps.isIdle(id))
        stalledError(
          'A worker, validation, recovery or control invocation is active. Wait for its owner; absence of progress is not exit proof.',
        );
    return {
      ...s,
      run,
      containerId: resource.containerId,
      taskId: pods.taskExecutions.snapshot(podId).taskId,
    };
  }
  function current(podId: string, record: StalledRecord) {
    const s = policy(podId);
    if (
      s.fingerprint !== record.binding.fingerprint ||
      stalledHash(s.run) !== stalledHash(record.binding.run)
    )
      stalledError(
        'The exact source, report, generation or resource selection changed. Original ownership remains retained.',
      );
    return s;
  }
  function inspectStalledWorkerRecovery(podId: string): StalledWorkerRecoveryView {
    const pod = pods.getOrThrow(podId);
    const latest = journal.latest(podId);
    const operation =
      latest?.receipt.request.expectedGeneration === pod.lifecycleGeneration &&
      latest.binding.run.cycle === pod.finalization?.cycle
        ? latest.receipt
        : null;
    const blockers: string[] = [];
    let binding = '';
    try {
      binding = selection(podId).fingerprint;
      if (operation?.state === 'settled')
        blockers.push(
          'Execution is settled, not repaired. Inspect Validation and the qualified environment repair/continuation controls for the remaining failure.',
        );
      else {
        policy(podId);
        journal.assertAvailable(podId);
      }
    } catch (e) {
      blockers.push(e instanceof Error ? e.message : 'Recovery evidence unavailable.');
    }
    let guidanceBlocker: string | null = null;
    try {
      deps.assertGuidanceCollected(podId);
    } catch (e) {
      guidanceBlocker = e instanceof Error ? e.message : 'Uncollected guidance remains pending.';
    }
    if (operation?.state === 'pending')
      blockers.push('Observe/reconcile the exact saved request; do not submit another stop.');
    return {
      schemaVersion: 1,
      podId,
      generation: pod.lifecycleGeneration,
      status: pod.status,
      binding: binding || stalledHash([podId, pod.lifecycleGeneration]),
      canStop: !blockers.length,
      blockers,
      failureReason: pod.failureReason,
      guidanceBlocker,
      operation,
    };
  }
  async function bounded<T>(operation: Promise<T>, label: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        operation,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`${label} timed out; observe the saved request.`)),
            30000,
          );
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  async function source(pod: Pod) {
    if (!deps.worktreeManager.inspectSourcePreservation)
      stalledError('Hardened source preservation inspection unavailable.');
    // Reuse the existing filter/fsmonitor/hooks/sparse-source refusal policy.
    // A copied worker .git/config must never execute with daemon authority.
    return deps.worktreeManager.inspectSourcePreservation(pod.worktreePath!, pod.branch);
  }
  async function run(
    podId: string,
    request: StalledWorkerRecoveryRequest,
    actor: OperatorActor,
    hash: string,
  ) {
    let record = journal.get(request.requestKey);
    if (record && (record.hash !== hash || record.receipt.podId !== podId))
      stalledError('Request key, body or actor conflicts with the saved request.');
    if (record?.receipt.state === 'settled') return record.receipt;
    const cm = deps.getContainerManager();
    if (!cm.getResourceKey) stalledError('Exact Docker engine/resource inspection is unavailable.');
    if (!record) {
      journal.assertAvailable(podId);
      const s = policy(podId);
      if (
        request.expectedGeneration !== s.pod.lifecycleGeneration ||
        request.expectedBinding !== s.fingerprint
      )
        stalledError('Selection is stale. Inspect again before submitting.');
      // The original identity comes ONLY from its immutable run binding. This fresh
      // inspection selects the engine containing that exact 256-bit Docker ID; it
      // does not claim a missing historical engine namespace was recorded.
      const resourceKey = await bounded(cm.getResourceKey(s.containerId), 'Docker identity lookup');
      if (!resourceKey) stalledError('Docker resource namespace unavailable.');
      const hostSource = await source(s.pod);
      if (!hostSource.worktreeClean)
        stalledError(
          'Host checkout has uncommitted changes. Preserve and reconcile them before stop-and-retain can sync the original workspace.',
        );
      const after = policy(podId);
      if (after.fingerprint !== s.fingerprint)
        stalledError('Source ownership changed during inspection.');
      const status = await bounded(cm.getStatus(s.containerId), 'Docker status lookup');
      if (status !== 'running' && status !== 'stopped')
        stalledError(
          'Recorded Docker resource is unknown or unavailable. No stop request was admitted.',
        );
      const receipt: StalledWorkerRecoveryReceipt = {
        podId,
        request,
        actor,
        state: 'pending',
        createdAt: new Date().toISOString(),
        settledAt: null,
        message:
          'Original execution retained. Observe the saved request until Docker termination and workspace preservation are verified.',
        resourcesRetained: true,
      };
      record = {
        receipt,
        hash,
        binding: { fingerprint: s.fingerprint, run: s.run, resourceKey, hostSource },
        archivePath: path.join(deps.root, request.requestKey, 'workspace'),
        stopDispatched: false,
        archivedSource: null,
        archiveFingerprint: null,
      };
      pods.atomically!(() => {
        if (policy(podId).fingerprint !== s.fingerprint)
          stalledError('Selection changed before admission.');
        journal.admit(record!, s.taskId, s.containerId, { pod: s.pod, reports: s.reports });
      });
    }
    const selected = record;
    const check = () => current(podId, selected);
    // Inventories are read-only and custody already holds. Avoid a full task/SQL
    // policy scan per dependency file/chunk; every proof boundary rechecks below.
    let inventoryChecks = 0;
    const inventoryCheck = () => {
      if (inventoryChecks++ % 128 === 0) check();
    };
    const original = check();
    const resourceKey = await bounded(
      cm.getResourceKey(original.containerId),
      'Docker identity lookup',
    );
    check();
    if (resourceKey !== selected.binding.resourceKey)
      stalledError('Docker engine/resource changed; original operation remains pending.');
    const gitIdentity = (value: unknown) => {
      const v = value as { branch: string; commitSha: string; treeSha: string };
      return stalledHash([v.branch, v.commitSha, v.treeSha]);
    };
    const exclude = (relative: string) =>
      relative.split(path.sep).some((part) => WORKSPACE_SYNC_EXCLUDES.includes(part));
    const syncFingerprint = (root: string) =>
      fingerprintPreservedWorkspace(root, inventoryCheck, exclude);
    const matchesHost = async (value: unknown) => {
      if (stalledHash(value) === stalledHash(selected.binding.hostSource)) return true;
      return (
        selected.archivedSource !== null &&
        gitIdentity(value) === gitIdentity(selected.archivedSource) &&
        (await syncFingerprint(original.pod.worktreePath!)).sha256 ===
          (await syncFingerprint(selected.archivePath)).sha256
      );
    };
    if (!(await matchesHost(await source(original.pod))))
      stalledError('Host Git source changed since admission; original workspace remains retained.');
    check();
    let status = await bounded(cm.getStatus(original.containerId), 'Docker status lookup');
    check();
    if (status === 'running' && !journal.get(request.requestKey)!.stopDispatched) {
      try {
        await bounded(
          journal.dispatchStop(selected, () => {
            check();
            return cm.stop(original.containerId);
          }),
          'Owned Docker stop',
        );
      } catch {
        journal.pendingMessage(
          request.requestKey,
          'Docker stop response failed or timed out. The dispatch is retained and will NOT be repeated. Refresh and reconcile this exact request. If Docker remains running/unknown, provider recovery is required; no cleanup or retry is authorized.',
        );
        return journal.get(request.requestKey)!.receipt;
      }
      check();
      status = await bounded(cm.getStatus(original.containerId), 'Docker stop observation');
      check();
    }
    if (status !== 'stopped') {
      journal.pendingMessage(
        request.requestKey,
        'Docker is still running or unknown after the saved stop dispatch. Execution remains held; refresh/observe the exact request. No second stop, worker, checks or deletion is authorized. Provider recovery is required if it cannot settle.',
      );
      return journal.get(request.requestKey)!.receipt;
    }
    // No wake, exec or deletion: getArchive works on STOPPED Docker containers.
    // Full extraction (including ignored files and .git) goes to a private, separate
    // retained archive before ordinary sync-back can change the canonical checkout.
    if (!selected.archivedSource) {
      await mkdir(path.dirname(selected.archivePath), { recursive: true, mode: 0o700 });
      check();
      await journal.preserve(podId, () =>
        cm.extractDirectoryFromContainer(
          original.containerId,
          '/workspace',
          selected.archivePath,
          [],
          {
            preserveRootMode: true,
            assertCurrent: () => {
              check();
            },
          },
        ),
      );
      check();
      const archivedSource = await source({ ...original.pod, worktreePath: selected.archivePath });
      check();
      // Dirty worker edits stay dirty, never silently committed or waived.
      const archiveFingerprint = await fingerprintPreservedWorkspace(
        selected.archivePath,
        inventoryCheck,
      );
      check();
      journal.recordArchive(request.requestKey, archivedSource, archiveFingerprint);
      selected.archivedSource = archivedSource;
      selected.archiveFingerprint = archiveFingerprint;
    }
    if (
      stalledHash(await source({ ...original.pod, worktreePath: selected.archivePath })) !==
      stalledHash(selected.archivedSource)
    )
      stalledError('Private workspace archive changed; no settlement is authorized.');
    if (
      !selected.archiveFingerprint ||
      (await fingerprintPreservedWorkspace(selected.archivePath, inventoryCheck)).sha256 !==
        selected.archiveFingerprint.sha256
    )
      stalledError(
        'Private workspace archive bytes or modes changed; retain the original resource.',
      );
    check();
    if (
      (await bounded(cm.getResourceKey(original.containerId), 'Docker identity lookup')) !==
      selected.binding.resourceKey
    )
      stalledError('Docker identity changed during preservation.');
    check();
    if (
      (await bounded(cm.getStatus(original.containerId), 'Docker stop observation')) !== 'stopped'
    )
      return journal.get(request.requestKey)!.receipt;
    check();
    if (!(await matchesHost(await source(original.pod))))
      stalledError(
        'Host source changed before workspace preservation; archive and original remain held.',
      );
    check();
    await journal.preserve(podId, () => deps.preserveWorkspace(original.pod));
    check();
    const preservedSource = await source(original.pod);
    check();
    if (
      gitIdentity(preservedSource) !== gitIdentity(selected.archivedSource) ||
      (await syncFingerprint(original.pod.worktreePath!)).sha256 !==
        (await syncFingerprint(selected.archivePath)).sha256
    )
      stalledError(
        'Canonical Git source does not match the stopped workspace archive. Commit import/sync remains incomplete; original source and archive are retained.',
      );
    if (
      (await bounded(cm.getResourceKey(original.containerId), 'Docker identity lookup')) !==
      selected.binding.resourceKey
    )
      stalledError('Docker identity changed before settlement.');
    check();
    if (
      (await bounded(cm.getStatus(original.containerId), 'Docker stop observation')) !== 'stopped'
    )
      return journal.get(request.requestKey)!.receipt;
    check();
    if (
      (await fingerprintPreservedWorkspace(selected.archivePath, inventoryCheck)).sha256 !==
      selected.archiveFingerprint?.sha256
    )
      stalledError('Private archive changed before final settlement.');
    check();
    if (
      (await bounded(cm.getResourceKey(original.containerId), 'Final Docker identity lookup')) !==
      selected.binding.resourceKey
    )
      stalledError('Final Docker engine/resource identity changed.');
    check();
    if (
      (await bounded(cm.getStatus(original.containerId), 'Final Docker stop observation')) !==
      'stopped'
    )
      return journal.get(request.requestKey)!.receipt;
    check();
    const receipt = pods.atomically!(() => {
      check();
      return journal.settle(
        selected,
        {
          source: preservedSource,
          archivedSource: selected.archivedSource,
          archiveFingerprint: selected.archiveFingerprint,
          archivePath: selected.archivePath,
          resourceKey,
          observedAt: new Date().toISOString(),
          proof: 'docker-stopped',
          exitCode: 'unknown',
        },
        () => {
          pods.completionJournal!.settle(
            original.pod,
            'Operator-owned Docker stop verified; original worker exit/result remains unknown. Source and reports preserved for separate recovery.',
          );
          pods.completionJournal!.mark(original.pod, 'ready', true);
          if (original.pod.status !== 'failed') deps.transition(original.pod, 'failed');
          pods.update(podId, {
            autoApprove: false,
            completedAt: new Date().toISOString(),
            lastCorrectionMessage:
              'Execution stopped with verified Docker resource proof and workspace archive. Failed checks remain failed. Choose validation recovery separately; pending guidance, budgets and retry authorization remain in force.',
          });
        },
      );
    });
    deps.emit(podId, receipt.message);
    return receipt;
  }
  function recoverStalledWorker(
    podId: string,
    request: StalledWorkerRecoveryRequest,
    actor: OperatorActor,
  ) {
    if (
      actor.type !== 'human' ||
      !actor.userId.trim() ||
      !/^[a-zA-Z0-9-]{1,64}$/.test(request.requestKey) ||
      !Number.isSafeInteger(request.expectedGeneration) ||
      request.expectedGeneration < 1 ||
      !/^[a-f0-9]{64}$/.test(request.expectedBinding) ||
      request.reason.trim().length < 10 ||
      request.reason.length > 4000 ||
      Object.keys(request).sort().join(',') !==
        'expectedBinding,expectedGeneration,reason,requestKey'
    )
      stalledError(
        'Authenticated human and exact bound request with a meaningful reason required.',
      );
    const hash = stalledHash([podId, request, actor]);
    const active = pending.get(podId);
    if (active) {
      if (active.hash !== hash)
        stalledError('A conflicting stop-and-retain request is in progress.');
      return active.promise;
    }
    const promise = run(
      podId,
      Object.freeze({ ...request }),
      Object.freeze({ ...actor }),
      hash,
    ).catch((error) => {
      const saved = journal.get(request.requestKey);
      if (saved?.hash === hash)
        journal.pendingMessage(
          request.requestKey,
          `${error instanceof Error ? error.message.slice(0, 600) : 'Preservation/reconciliation failed.'} Original resource remains retained; observe this exact request. No new stop or retry is authorized.`,
        );
      throw error;
    });
    pending.set(podId, { hash, promise });
    void promise
      .finally(() => {
        if (pending.get(podId)?.promise === promise) pending.delete(podId);
      })
      .catch(() => {});
    return promise;
  }
  return {
    inspectStalledWorkerRecovery,
    recoverStalledWorker,
    isActive: (id: string) => pending.has(id),
  };
}
