import path from 'node:path';
import {
  type OperatorActor,
  type ValidationHeldStopView,
  validationHeldStopRequestSchema,
} from '@autopod/shared';
import type { RetainedCleanupDocker } from '../containers/retained-cleanup-docker.js';
import { gitWorktreeIdentity } from '../worktrees/allocation-identity.js';
import { qualifyRetainedGit } from '../worktrees/retained-cleanup-host.js';
import type { PodRepository } from './pod-repository.js';
import { block, diagnostic } from './retained-cleanup-proof.js';
import { cleanupConflict, overlaps, type Target } from './retained-cleanup-repository.js';
import { finalizationHash } from './retained-finalization-repository.js';
import { requiresValidationSettlement } from './validation-recovery-policy.js';

const retainedMessage =
  'Execution stopped; worktree, reports, card and validation hold retained. Historical command exit remains unknown. Discard requires a separate preview and data-loss confirmation.';
const publicResources = (targets: Target[]) =>
  targets.map(({ kind, role, id, namespace }) => ({ kind, role, id, namespace }));
type HeldEvidence = { kind: 'validation-held-docker'; source: string; targets: Target[] };
export function heldDockerEvidence(value: unknown): HeldEvidence | null {
  const e = value as HeldEvidence | null;
  return e?.kind === 'validation-held-docker' && Array.isArray(e.targets) ? e : null;
}

export function createValidationHeldDockerControl(deps: {
  pods: PodRepository;
  docker?: RetainedCleanupDocker;
  isIdle(id: string): boolean;
  isGoal(id: string): boolean;
}) {
  const { pods, docker } = deps;
  const ledger = pods.retainedFinalizations!;
  const store = pods.retainedCleanup!;
  const fallback = {
    code: 'OBSERVATION_UNAVAILABLE',
    message: 'Exact local Docker/Git ownership could not be observed.',
  } as const;
  function durable(podId: string) {
    const p = pods.getOrThrow(podId);
    if (
      !docker ||
      !store ||
      !ledger ||
      !pods.rewriteAbandonments ||
      !pods.validationExecutions ||
      !pods.taskExecutions ||
      !pods.sourceAdoptions ||
      !pods.externalDeliveries
    )
      block('UNAVAILABLE', 'Required exact Docker transport or durable ledgers are unavailable.');
    const c = store.context(podId);
    const h = store.heldHistory(podId);
    if (
      p.executionTarget !== 'local' ||
      p.options.agentMode !== 'auto' ||
      !['pr', 'branch'].includes(p.options.output) ||
      p.status !== 'review_required' ||
      !requiresValidationSettlement(p) ||
      deps.isGoal(podId) ||
      pods.validationExecutions!.hasGoal(podId) ||
      p.profileSnapshot?.testPipeline ||
      p.linkedPodId ||
      p.fixPodId ||
      p.dependsOnPodId ||
      p.dependsOnPodIds?.length ||
      p.recoveryWorktreePath ||
      p.requireSidecars?.length ||
      Object.keys(p.sidecarContainerIds ?? {}).length ||
      p.testRunBranches?.length ||
      c.incompatible ||
      h.extra.length
    )
      block(
        'UNSUPPORTED_TOPOLOGY',
        'Only ordinary validation-held local Docker tasks are supported; linked work, Goals, extra execution/source custody and external runners are excluded.',
      );
    if (!c.membership || h.members.length !== 1 || c.lineage.length)
      block(
        'UNSUPPORTED_HISTORY',
        'Exact single-task membership and historical execution closure are unavailable.',
      );
    if (
      !deps.isIdle(podId) ||
      c.unsettled ||
      p.pendingEscalation ||
      pods.hasUnansweredDecision?.(podId)
    )
      block(
        'NOT_SETTLED',
        'A worker, admission, reviewer, control or pending decision owns this task.',
      );
    const failure = p.lastValidationResult?.infrastructureFailure;
    if (
      failure?.code !== 'EXEC_EXIT_UNVERIFIED' ||
      !['setup', 'lint', 'sast', 'build', 'test', 'facts'].includes(failure.phase)
    )
      block(
        'UNSUPPORTED_TOPOLOGY',
        'The unknown execution is not qualified as an ordinary in-container validation command; host/browser/reviewer or unknown topology needs separate evidence.',
      );
    try {
      pods.taskExecutions!.assertCanDelete(podId);
      pods.validationExecutions!.assertNoActiveTaskExecution(podId);
      pods.validationExecutions!.assertNoPendingRecovery(podId);
      pods.sourceAdoptions!.assertControlPlaneSettled(podId);
      pods.externalDeliveries!.assertDeletable(podId);
      pods.deletionOwnership?.assertTaskAvailable(podId);
      pods.sandboxWakeups?.recovery.assertAvailable(podId);
      if (p.prUrl) pods.mergeJournal?.assertPublicationAllowed?.(p.prUrl);
    } catch {
      block(
        'NOT_SETTLED',
        'Worker/admission, validation recovery, publication or deletion custody is unresolved.',
      );
    }
    if (
      !p.containerId ||
      !/^[a-f0-9]{64}$/.test(p.containerId) ||
      !p.worktreePath ||
      p.worktreePath !== path.resolve(p.worktreePath)
    )
      block(
        'UNSUPPORTED_HISTORY',
        'Full recorded main Docker ID and exact local checkout are required.',
      );
    const historical = ledger.historicalClaims(podId);
    for (const worker of h.workers) {
      const binding = JSON.parse(worker.binding);
      if (
        worker.generation !== p.lifecycleGeneration ||
        (binding.resource &&
          (binding.resource.containerId !== p.containerId ||
            binding.resource.executionTarget !== 'local'))
      )
        block(
          'UNSUPPORTED_HISTORY',
          'Historical worker custody refers to another generation or execution resource.',
        );
    }
    if (
      h.admissions.some(
        (a) => a.generation !== p.lifecycleGeneration || a.stage === 'sandbox_startup',
      )
    )
      block(
        'UNSUPPORTED_HISTORY',
        'Historical admissions include another generation or external execution topology.',
      );
    if (
      historical.resources.some((id) => id !== p.containerId) ||
      historical.sourceLocations.some((v) => v !== p.worktreePath)
    )
      block(
        'UNSUPPORTED_HISTORY',
        'Historical execution/source claims exceed the selected main container and checkout.',
      );
    for (const d of h.dispatches) {
      const b = JSON.parse(d.binding);
      if (
        b.executionTarget !== 'local' ||
        b.containerId !== p.containerId ||
        b.worktreePath !== p.worktreePath ||
        b.taskId !== c.membership!.task_id ||
        b.generation !== p.lifecycleGeneration
      )
        block(
          'UNSUPPORTED_HISTORY',
          'Historical validation dispatch belongs to a different exact execution.',
        );
    }
    return {
      pod: p,
      context: c,
      history: h,
      source: finalizationHash([pods.rewriteAbandonments!.source(p), h]),
    };
  }
  function guardTargets(podId: string, targets: Target[]) {
    const d = durable(podId);
    const containers = targets.filter((t) => t.kind === 'docker_container');
    const bridges = targets.filter((t) => t.kind === 'docker_bridge');
    const locations = targets.filter((t) => t.kind === 'host_worktree').map((t) => t.id);
    for (const dispatch of d.history.dispatches) {
      const b = JSON.parse(dispatch.binding);
      if (
        b.resourceScope !== JSON.stringify(['docker', containers[0]!.namespace, containers[0]!.id])
      )
        block(
          'UNSUPPORTED_HISTORY',
          'Historical validation has a different or unavailable exact Engine binding.',
        );
    }
    for (const a of d.history.allocations) {
      const e = a.evidence && JSON.parse(a.evidence);
      if (
        a.kind !== 'owned' ||
        a.generation !== d.pod.lifecycleGeneration ||
        !e ||
        (a.role === 'original-worktree'
          ? !locations.includes(e.worktree?.path)
          : !['container', 'bridge'].includes(a.role) ||
            !targets.some((t) => t.namespace === e.engineId && t.id === e.id))
      )
        block(
          'UNSUPPORTED_HISTORY',
          'An unpaged historical allocation is unresolved or outside the exact selected topology.',
        );
      if (
        a.role === 'container' &&
        (e.bridge?.id !== bridges[0]?.id || e.sourceMount !== locations[0])
      )
        block('IDENTITY_CHANGED', 'The producer records a different source mount or bridge.');
    }
    try {
      for (const t of containers) {
        pods.validationExecutions!.assertResourceUnshared(podId, t.id);
        pods.rewriteAbandonments!.assertUnshared(podId, t.id, locations);
        pods.externalDeliveries!.assertReleasable(t.id);
      }
      store.assertForeignClaims(
        podId,
        containers.map((t) => t.id),
        locations,
      );
      store.assertNetworkReleaseSettled(
        podId,
        bridges.map((t) => t.id),
      );
      store.assertAllocationTransportsSettled(
        bridges.map((t) => t.name),
        locations,
      );
      for (const a of store.foreignAllocations(d.context.membership!.task_id)) {
        const e = a.evidence && JSON.parse(a.evidence);
        if (e && targets.some((t) => t.namespace === e.engineId && t.id === e.id))
          cleanupConflict('A foreign producer claims this exact Docker resource.');
        if (
          ['original-worktree', 'prepared-source'].includes(a.role) &&
          path.isAbsolute(a.locator) &&
          locations.some((l) => overlaps(l, a.locator))
        )
          cleanupConflict('A foreign producer claims this checkout.');
      }
    } catch {
      block(
        'OWNERSHIP_CONFLICT',
        'A competing resource, source, bridge or admission claim exists.',
      );
    }
    return d;
  }
  async function select(podId: string) {
    const d = durable(podId);
    if (ledger.get(podId) || store.forPod(podId))
      cleanupConflict('Another retained control owns this pod.');
    const guard = () => {
      if (durable(podId).source !== d.source || ledger.get(podId) || store.forPod(podId))
        cleanupConflict('Selection or custody changed; refresh preview.');
    };
    if (!d.pod.branch) block('UNSUPPORTED_HISTORY', 'Recorded Git branch identity is unavailable.');
    const git = await gitWorktreeIdentity(
      d.pod.worktreePath!,
      'shared-cache',
      undefined,
      d.pod.branch,
    );
    guard();
    qualifyRetainedGit(git);
    const targets: Target[] = [
      ...(await docker!.discover(podId, d.pod.containerId!, d.pod.worktreePath!, guard)),
      {
        kind: 'host_worktree',
        role: 'original_checkout',
        id: git.worktree.path,
        namespace: [git.worktree.device, git.worktree.inode, git.worktree.birthtimeNs].join(':'),
        git,
      },
    ];
    const current = () => {
      guard();
      guardTargets(podId, targets);
    };
    await docker!.proof(targets, current, true);
    const stopped = await docker!.stopped(targets, current);
    const evidence: HeldEvidence = { kind: 'validation-held-docker', source: d.source, targets };
    return { d, evidence, stopped, binding: finalizationHash(evidence), guard: current };
  }
  async function inspect(podId: string): Promise<ValidationHeldStopView> {
    const prior = ledger?.get(podId);
    if (prior && heldDockerEvidence(prior.evidence))
      return receipt(podId, prior.receipt.request.requestKey);
    try {
      const s = await select(podId);
      return {
        podId,
        state: 'eligible',
        generation: s.d.pod.lifecycleGeneration,
        binding: s.binding,
        resources: publicResources(s.evidence.targets),
        observedStopped: s.stopped,
        blockers: [],
        message:
          'Stop retains local files, reports, card and validation hold. No checks, worker, publication or historical exit settlement is authorized.',
      };
    } catch (e) {
      return {
        podId,
        state: 'blocked',
        blockers: [diagnostic(e, fallback)],
        message: 'No effects admitted.',
      };
    }
  }
  function receipt(podId: string, key: string): ValidationHeldStopView {
    const r = ledger.get(podId);
    if (!r || r.receipt.request.requestKey !== key || !heldDockerEvidence(r.evidence))
      cleanupConflict('No matching validation-held Stop receipt.');
    return {
      podId,
      requestKey: key,
      generation: r.binding.generation,
      binding: r.binding.fingerprint,
      resources: publicResources(heldDockerEvidence(r.evidence)!.targets),
      blockers: [],
      state: r.receipt.state === 'finalized' ? 'stopped' : r.stopDispatched ? 'unknown' : 'pending',
      message:
        r.receipt.state === 'finalized'
          ? retainedMessage
          : 'Observe or reconcile this exact request and actor. An uncertain Stop is never dispatched again.',
    };
  }
  async function submit(
    podId: string,
    input: unknown,
    actor: OperatorActor,
  ): Promise<ValidationHeldStopView> {
    if (actor.type !== 'human' || !actor.userId.trim())
      cleanupConflict('An authenticated human is required.');
    const request = validationHeldStopRequestSchema.parse(input);
    const human = { type: 'human' as const, userId: actor.userId };
    const hash = finalizationHash([podId, request, human]);
    let row = ledger.get(podId);
    if (row) {
      if (row.requestHash !== hash || !heldDockerEvidence(row.evidence))
        cleanupConflict('Conflicting Stop key, actor or exact selection.');
      if (row.receipt.state === 'finalized') return receipt(podId, request.requestKey);
    } else {
      const s = await select(podId);
      if (
        request.expectedGeneration !== s.d.pod.lifecycleGeneration ||
        request.expectedBinding !== s.binding
      )
        cleanupConflict('Stale generation or selection; no effects admitted.');
      s.guard();
      ledger.admit(
        {
          fingerprint: s.binding,
          generation: request.expectedGeneration,
          containerId: s.d.pod.containerId,
          target: 'local',
          worktreePath: s.d.pod.worktreePath,
          resources: [s.d.pod.containerId!],
          taskId: s.d.context.membership!.task_id,
          owners: [],
          resourceKey: JSON.stringify([
            'docker',
            s.evidence.targets[0]!.namespace,
            s.d.pod.containerId,
          ]),
          sourceLocations: [s.d.pod.worktreePath!],
        },
        {
          podId,
          request,
          actor: human,
          state: 'pending',
          createdAt: new Date().toISOString(),
          finalizedAt: null,
          message: retainedMessage,
          resourcesRetained: true,
        },
        hash,
        s.evidence,
      );
      row = ledger.get(podId)!;
    }
    const evidence = heldDockerEvidence(row.evidence)!;
    const guard = () => {
      const d = guardTargets(podId, evidence.targets);
      const now = ledger.get(podId);
      if (d.source !== evidence.source || now?.requestHash !== hash || store.forPod(podId))
        cleanupConflict('Stop source or custody changed.');
    };
    try {
      guard();
      for (const t of evidence.targets)
        if (t.kind === 'host_worktree') {
          qualifyRetainedGit(t.git);
          const live = await gitWorktreeIdentity(
            t.id,
            'shared-cache',
            t.git.commonStore.path,
            pods.getOrThrow(podId).branch,
          );
          guard();
          if (finalizationHash(live) !== finalizationHash(t.git))
            block('IDENTITY_CHANGED', 'Exact retained Git registration changed.');
        }
      if (!(await docker!.stopped(evidence.targets, guard)) && !row.stopDispatched) {
        try {
          await ledger.dispatchStop(podId, () => docker!.stop(evidence.targets, guard), guard);
        } catch {
          guard();
        }
      }
      if (await docker!.stopped(evidence.targets, guard)) {
        guard();
        pods.atomically!(() => ledger.terminal(podId, () => ledger.finish(podId, evidence)));
      }
      return receipt(podId, request.requestKey);
    } catch (e) {
      return {
        ...receipt(podId, request.requestKey),
        state: 'unknown',
        blockers: [diagnostic(e, fallback)],
      };
    }
  }
  function cleanupSelection(podId: string) {
    const row = ledger?.get(podId);
    const e = heldDockerEvidence(row?.evidence);
    if (!e) return null;
    if (row!.receipt.state !== 'finalized')
      block('PENDING_STOP', 'Reconcile the exact Stop request first.');
    const d = guardTargets(podId, e.targets);
    if (d.source !== e.source) block('IDENTITY_CHANGED', 'The retained Stop selection changed.');
    return {
      targets: e.targets,
      state: finalizationHash([e, row]),
      taskId: d.context.membership!.task_id,
      sessionId: d.context.membership!.execution_id,
      generation: d.pod.lifecycleGeneration,
    };
  }
  return { inspect, submit, receipt, cleanupSelection };
}
