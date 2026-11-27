import path from 'node:path';
import {
  type OperatorActor,
  PodNotFoundError,
  type RetainedCleanupInspection,
  type RetainedCleanupSubmission,
  retainedCleanupRequestSchema,
} from '@autopod/shared';
import type { RetainedCleanupDocker } from '../containers/retained-cleanup-docker.js';
import {
  createRetainedCleanupHost,
  type RetainedCleanupHost,
} from '../worktrees/retained-cleanup-host.js';
import type { PodRepository } from './pod-repository.js';
import { isDockerNativeId, type PhysicalIdentity } from './retained-allocation-inventory.js';
import { block, diagnostic } from './retained-cleanup-proof.js';
import {
  cleanupConflict,
  overlaps,
  type Selection,
  type Target,
} from './retained-cleanup-repository.js';
import { finalizationHash } from './retained-finalization-repository.js';
import { retainedPathIdentity } from './retained-path-identity.js';
import { assertValidationMutationSettled } from './validation-recovery-policy.js';

const nsHost = (p: PhysicalIdentity) => [p.device, p.inode, p.birthtimeNs].join(':');
const conflict = (detail: string, id?: string) => block('OWNERSHIP_CONFLICT', detail, id);
const unsupported = (detail: string) => block('UNSUPPORTED_TOPOLOGY', detail);
const canonical = (p: PhysicalIdentity) =>
  p.path === p.realpath && p.path !== '/' && p.path === path.resolve(p.path);

export function createRetainedCleanup(deps: {
  pods: PodRepository;
  docker?: RetainedCleanupDocker;
  host?: RetainedCleanupHost;
  isIdle(podId: string): boolean;
  isGoal(podId: string): boolean;
  heldSelection?(podId: string): {
    targets: Target[];
    state: string;
    taskId: string;
    generation: number;
    sessionId: string;
  } | null;
}) {
  const { pods, docker } = deps;
  const store = pods.retainedCleanup!;
  const host = deps.host ?? createRetainedCleanupHost();
  const flights = new Map<string, { hash: string; promise: Promise<RetainedCleanupSubmission> }>();
  const unavailable = () =>
    block(
      'UNAVAILABLE',
      'Dedicated Docker cleanup transport or required durable custody ledger is unavailable.',
    );
  const commonFallback = {
    code: 'OBSERVATION_UNAVAILABLE',
    message: 'Exact Docker/host observation did not complete.',
  } as const;

  function durable(podId: string) {
    pods.operatorDisposals?.assertAvailable(podId);
    const held = deps.heldSelection?.(podId);
    if (held) return held;
    const pod = pods.getOrThrow(podId);
    const { membership, lineage, incompatible, unsettled } = store.context(podId);
    const {
      taskExecutions,
      validationExecutions,
      sourceAdoptions,
      externalDeliveries,
      retainedFinalizations,
      retainedAllocations,
      rewriteAbandonments,
      deletionOwnership,
    } = pods;
    if (
      !docker ||
      !taskExecutions ||
      !validationExecutions ||
      !sourceAdoptions ||
      !externalDeliveries ||
      !retainedFinalizations ||
      !retainedAllocations ||
      !rewriteAbandonments ||
      !deletionOwnership
    )
      return unavailable();
    if (!membership) block('UNSUPPORTED_HISTORY', 'No live enrolled task execution is present.');
    const inventory = retainedAllocations.readTask(membership!.task_id);
    if (inventory.state !== 'recorded')
      block(
        'UNSUPPORTED_HISTORY',
        'The unpaged v1 producer inventory is incomplete: ' +
          [...new Set(inventory.reasons.map((r) => r.code))].join(', '),
      );
    if (
      pod.executionTarget !== 'local' ||
      pod.options.agentMode !== 'auto' ||
      !['pr', 'branch'].includes(pod.options.output) ||
      deps.isGoal(podId) ||
      incompatible ||
      pod.linkedPodId ||
      pod.fixPodId ||
      pod.dependsOnPodId ||
      pod.dependsOnPodIds?.length ||
      pod.recoveryWorktreePath ||
      Object.keys(pod.sidecarContainerIds ?? {}).length ||
      pod.requireSidecars?.length ||
      Object.keys(pod.testRunBranches ?? {}).length
    )
      unsupported(
        'Cleanup supports ordinary local retained continuations only; extra owners, resources or linked work remain.',
      );
    if (
      !lineage.length ||
      lineage.length !== pod.lifecycleGeneration - 1 ||
      lineage.some((r, i) => r.generation !== i + 1 || !r.activated || !r.checked)
    )
      block(
        'NOT_SETTLED',
        'Every continuation must be activated with settled checks and an exact recorded predecessor.',
      );
    const final = retainedFinalizations.get(podId);
    if (final?.receipt.state === 'pending' || pod.status === 'killing')
      block(
        'PENDING_STOP',
        'Stop and retain has not finalized. Reconcile the exact Stop request first.',
      );
    if (pod.status === 'killed') {
      if (
        !final ||
        final.receipt.state !== 'finalized' ||
        final.receipt.request.mode !== 'stop-retain' ||
        final.binding.target !== 'local' ||
        final.binding.generation !== pod.lifecycleGeneration ||
        final.binding.taskId !== membership!.task_id ||
        final.binding.worktreePath !== pod.worktreePath ||
        final.binding.containerId !== pod.containerId
      )
        conflict('A killed row requires the matching completed Stop and retain receipt.');
    } else if (final || !['failed', 'review_required'].includes(pod.status)) {
      block(
        'NOT_SETTLED',
        'Cleanup requires idle failed/review-held execution or completed Stop and retain.',
      );
    }
    if (
      unsettled ||
      !deps.isIdle(podId) ||
      pod.pendingEscalation ||
      pods.hasUnansweredDecision?.(podId)
    )
      block(
        'NOT_SETTLED',
        'An active control, worker, check, recovery, or pending human decision owns this task.',
      );
    try {
      taskExecutions.assertCanDelete(podId);
      validationExecutions.assertNoActiveTaskExecution(podId);
      validationExecutions.assertNoPendingRecovery(podId);
      assertValidationMutationSettled(pods, podId);
    } catch {
      block('NOT_SETTLED', 'Worker or validation settlement/recovery remains unresolved.');
    }
    try {
      sourceAdoptions.assertControlPlaneSettled(podId);
      externalDeliveries.assertDeletable(podId);
      if (pod.prUrl) pods.mergeJournal?.assertPublicationAllowed?.(pod.prUrl);
      deletionOwnership.assertTaskAvailable(podId);
    } catch {
      conflict('Unresolved source publication, delivery, or legacy deletion owns this task.');
    }
    const containers: Target[] = [];
    const bridges: Target[] = [];
    const checkouts: Target[] = [];
    const roots: Target[] = [];
    for (const a of inventory.allocations) {
      if (a.state !== 'owned') continue;
      if (a.role === 'bridge' || a.role === 'container') {
        const { engineId, id } = a.evidence;
        if (
          !isDockerNativeId(id) ||
          a.createReply?.engineId !== engineId ||
          a.createReply?.id !== id ||
          !engineId ||
          !a.locator
        )
          block('UNSUPPORTED_HISTORY', 'An exact Docker producer reply/identity is missing.');
        if (a.role === 'bridge') {
          bridges.push({
            kind: 'docker_bridge',
            role: 'owned_bridge',
            id,
            namespace: engineId,
            name: a.locator,
            attemptId: a.id,
          });
        } else {
          if (!a.evidence.sourceMount)
            unsupported('An execution has no exact recorded source mount.');
          containers.push({
            kind: 'docker_container',
            role: 'guest_execution',
            id,
            namespace: engineId,
            name: a.locator,
            attemptId: a.id,
            bridgeId: a.evidence.bridge.id,
            sourceMount: a.evidence.sourceMount!,
          });
        }
      } else if (a.role === 'original-worktree' || a.role === 'prepared-source') {
        const g = a.role === 'original-worktree' ? a.evidence : a.evidence.privateGit;
        if (
          ![g.worktree, g.gitlink, g.registration, g.commonStore].every(canonical) ||
          g.gitlink.path !== path.join(g.worktree.path, '.git') ||
          path.dirname(g.registration.path) !== path.join(g.commonStore.path, 'worktrees') ||
          overlaps(g.worktree.path, g.commonStore.path)
        )
          unsupported('A checkout has unsupported physical Git path relationships.');
        const role = a.role === 'original-worktree' ? 'original_checkout' : 'prepared_checkout';
        if (
          g.commonStoreOwnership !==
          (role === 'original_checkout' ? 'shared-cache' : 'private-prepared')
        )
          unsupported('Git common-store ownership does not match its producer role.');
        checkouts.push({
          kind: 'host_worktree',
          role,
          id: g.worktree.path,
          namespace: nsHost(g.worktree),
          git: g,
        });
        if (a.role === 'prepared-source') {
          const {
            privateRoot: root,
            privateSnapshotRoot: snapshotRoot,
            privateSnapshot: snapshot,
            privateSnapshotReceipt: receipt,
            privateBundle: bundle,
          } = a.evidence;
          if (
            ![root, snapshotRoot, snapshot, receipt, bundle].every(canonical) ||
            root.path !== a.locator ||
            g.worktree.path !== path.join(root.path, 'worktree') ||
            g.commonStore.path !== path.join(root.path, 'repository.git') ||
            bundle.path !== path.join(root.path, 'source.bundle') ||
            snapshotRoot.path !== path.join(root.path, 'host') ||
            path.dirname(snapshot.path) !== snapshotRoot.path ||
            receipt.path !== snapshot.path + '.receipt.json'
          )
            unsupported('Prepared source is not closed inside its private producer root.');
          roots.push({
            kind: 'host_prepared_root',
            role: 'private_prepared_source',
            id: root.path,
            namespace: nsHost(root),
            root,
            git: g,
            snapshotRoot,
            snapshot,
            receipt,
            bundle,
          });
        }
      }
    }
    const namespace = containers[0]?.namespace;
    const targets = [...containers, ...bridges, ...checkouts, ...roots];
    if (
      !namespace ||
      new Set(targets.map((t) => t.id)).size !== targets.length ||
      !bridges.length ||
      [...containers, ...bridges].some((t) => t.namespace !== namespace) ||
      roots.length !== lineage.length ||
      checkouts.length !== roots.length + 1 ||
      checkouts.filter((t) => t.role === 'original_checkout').length !== 1 ||
      !checkouts.some((t) => t.id === pod.worktreePath) ||
      !containers.some((t) => t.id === pod.containerId)
    )
      unsupported('Allocation set is not a complete single-engine, private checkout topology.');
    for (const t of checkouts) {
      if (t.kind !== 'host_worktree') continue;
      if (
        [...checkouts, ...roots].some(
          (other) =>
            other !== t &&
            overlaps(t.id, other.id) &&
            !(other.kind === 'host_prepared_root' && other.git.worktree.path === t.id),
        )
      )
        unsupported('Private checkout roots overlap unrelated allocation paths.');
      if (
        roots.some(
          (root) =>
            root.kind === 'host_prepared_root' &&
            overlaps(root.id, t.git.commonStore.path) &&
            root.git.worktree.path !== t.id,
        )
      )
        unsupported('A Git common store overlaps an unrelated private removal root.');
    }
    if (roots.some((r, i) => roots.some((q, j) => i !== j && overlaps(r.id, q.id))))
      unsupported('Private prepared roots overlap.');
    for (const r of lineage) {
      if (
        !containers.some(
          (t) =>
            t.id === r.container_id &&
            r.resource_key === JSON.stringify(['docker', namespace, t.id]),
        )
      )
        conflict('A predecessor checkpoint refers to a different exact execution.');
    }
    const historical = retainedFinalizations.historicalClaims(podId);
    if (
      [...historical.resources, ...(final?.binding.resources ?? [])].some(
        (id) => !containers.some((t) => t.id === id),
      ) ||
      (final &&
        final.binding.resourceKey !== JSON.stringify(['docker', namespace, pod.containerId]))
    )
      conflict('Historical execution or Stop claims exceed or disagree with inventory closure.');
    const locations = [...checkouts, ...roots].map((t) => t.id);
    try {
      for (const t of containers) {
        validationExecutions.assertResourceUnshared(podId, t.id);
        rewriteAbandonments.assertUnshared(podId, t.id, locations);
        externalDeliveries.assertReleasable(t.id);
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
        bridges.flatMap((t) => (t.kind === 'docker_bridge' ? [t.name] : [])),
        locations,
      );
    } catch {
      conflict('A foreign task, validation or source owner claims a selected resource.');
    }
    for (const a of store.foreignAllocations(membership!.task_id)) {
      const ev = a.evidence && JSON.parse(a.evidence);
      if (
        ev &&
        (a.role === 'bridge' || a.role === 'container') &&
        [...bridges, ...containers].some((t) => t.namespace === ev.engineId && t.id === ev.id)
      )
        conflict('A foreign allocation records the same native ID.', ev.id);
      if (
        (a.role === 'original-worktree' || a.role === 'prepared-source') &&
        path.isAbsolute(a.locator) &&
        locations.some(
          (l) =>
            overlaps(l, path.resolve(a.locator)) || overlaps(l, retainedPathIdentity(a.locator)),
        )
      )
        conflict('A foreign allocation overlaps selected host source.');
    }
    const state = finalizationHash([
      membership,
      lineage,
      inventory,
      final,
      pod.id,
      pod.status,
      pod.lifecycleGeneration,
      pod.worktreePath,
      pod.containerId,
      pod.launchConfigDigest,
      pod.lastValidationResult,
      pod.preSubmitReview,
      pod.prUrl,
      pod.options,
      historical,
    ]);
    return {
      targets,
      state,
      taskId: membership!.task_id,
      generation: pod.lifecycleGeneration,
      sessionId: membership!.execution_id,
    };
  }

  async function observe(targets: Target[], guard: () => void, full = false) {
    guard();
    const absentHost = await host.proof(targets, guard, full);
    guard();
    const absentNative = await docker!.proof(targets, guard);
    guard();
    return new Set([...absentNative, ...absentHost]);
  }
  async function select(podId: string) {
    const d = durable(podId);
    const guard = () => {
      if (store.forPod(podId)) cleanupConflict('A cleanup request already owns this task.');
      if (durable(podId).state !== d.state)
        cleanupConflict('Task or allocation binding changed; refresh preview.');
    };
    const absent = await observe(d.targets, guard, true);
    const resources = d.targets.map(({ id, namespace, kind, role }) => ({
      id,
      namespace,
      kind,
      role,
    }));
    const plan = {
      version: 1 as const,
      generation: d.generation,
      sessionId: d.sessionId,
      resources,
      binding: finalizationHash([1, d.state, d.targets, [...absent].sort()]),
      dataLoss: [
        'All listed container writable layers and logs.',
        'Unpublished files and reports in the listed worktrees, private snapshots, private Git stores and bundles.',
      ],
      retained: [
        'History, validation/review and cost evidence, Stop and continuation receipts, external PRs and refs.',
      ],
      notReclaimed: [
        'Shared Git cache and its local refs/objects, container images and volumes, shared or separately stored runtime, cache, input, and report data.',
      ],
    };
    return {
      selection: {
        plan,
        taskId: d.taskId,
        durable: d.state,
        targets: d.targets,
        absentAtAdmission: [...absent].sort(),
      },
      guard,
    };
  }
  async function inspect(podId: string): Promise<RetainedCleanupInspection> {
    const admitted = store.forPod(podId);
    if (admitted) return { state: 'requested', podId, requestId: admitted.id };
    pods.getOrThrow(podId);
    try {
      return { state: 'eligible', podId, plan: (await select(podId)).selection.plan };
    } catch (e) {
      const existing = store.forPod(podId);
      if (existing) return { state: 'requested', podId, requestId: existing.id };
      return { state: 'blocked', podId, blockers: [diagnostic(e, commonFallback)] };
    }
  }
  function receipt(podId: string, id: string) {
    const row = store.get(id);
    if (!row || row.pod_id !== podId) throw new PodNotFoundError(podId);
    return store.receipt(row);
  }
  async function execute(row: NonNullable<ReturnType<typeof store.get>>) {
    if (store.completed(row.id)) return store.receipt(row);
    const selected = JSON.parse(row.binding) as Selection;
    const deadline = performance.now() + 90_000;
    const enforceDeadline = () => {
      if (performance.now() >= deadline)
        block(
          'OBSERVATION_UNAVAILABLE',
          'Cleanup invocation expired; observe and reconcile the same request.',
        );
    };
    const guard = () => {
      enforceDeadline();
      if (
        store.completed(row.id) ||
        store.get(row.id)?.binding !== row.binding ||
        durable(row.pod_id).state !== selected.durable
      )
        conflict('The durable cleanup binding is no longer current.');
    };
    const proved = async (full = false) => {
      const absent = await observe(selected.targets, guard, full);
      for (const [i, t] of selected.targets.entries())
        if (
          (store.has(row.id, i, 'absent') || selected.absentAtAdmission.includes(t.id)) &&
          !absent.has(t.id)
        )
          block('IDENTITY_CHANGED', 'A previously absent target is no longer proven absent.', t.id);
      return absent;
    };
    try {
      let absent = await proved(true);
      for (const [i, t] of selected.targets.entries()) {
        guard();
        if (!absent.has(t.id)) {
          if (!store.has(row.id, i, 'dispatch')) {
            const dispatch = () => {
              guard();
              // No awaits between durable dispatch and invoking the native effect.
              return store.dispatch(row.id, i);
            };
            try {
              if (t.kind === 'docker_container' || t.kind === 'docker_bridge')
                await docker!.remove(t, guard, dispatch);
              else
                await host.remove(t, selected.targets, guard, dispatch, () => {
                  enforceDeadline();
                  store.assertInFlight(row.id, i);
                });
            } catch (e) {
              guard();
              if (!store.has(row.id, i, 'dispatch')) throw e;
              // A transport/Git error is not absence. Independently inspect below.
            }
            absent = await proved();
          }
          if (!absent.has(t.id))
            block(
              'REMOVAL_UNCONFIRMED',
              'Exact removal is unconfirmed. Observe absence; an already dispatched removal will not repeat.',
              t.id,
            );
        }
        guard();
        store.append(row.id, i, 'absent');
      }
      await proved();
      try {
        store.finish(row, guard);
      } catch {
        guard();
        block(
          'FLEET_REMOVAL_UNCONFIRMED',
          'All resources are absent, but History/fleet removal could not commit. Reconcile this same request.',
        );
      }
    } catch (e) {
      if (!store.completed(row.id)) store.block(row.id, diagnostic(e, commonFallback));
    }
    return store.receipt(row);
  }
  async function submit(
    podId: string,
    input: unknown,
    actor: OperatorActor,
  ): Promise<RetainedCleanupSubmission> {
    if (actor.type !== 'human' || !actor.userId.trim())
      cleanupConflict('An authenticated human is required.');
    const request = retainedCleanupRequestSchema.parse(input);
    const human = { type: 'human' as const, userId: actor.userId };
    const hash = finalizationHash([podId, request, human]);
    const flight = flights.get(request.id);
    if (flight) {
      if (flight.hash !== hash)
        cleanupConflict('Request key already in use with a different binding or actor.');
      return flight.promise;
    }
    const promise = (async (): Promise<RetainedCleanupSubmission> => {
      const prior = store.get(request.id);
      if (prior) {
        if (
          finalizationHash([prior.pod_id, JSON.parse(prior.request), JSON.parse(prior.actor)]) !==
          hash
        )
          cleanupConflict('Request key already owns a different binding, actor or reason.');
        return execute(prior);
      }
      if (store.forPod(podId)) cleanupConflict('Another request already owns this pod.');
      pods.getOrThrow(podId);
      let selected: Awaited<ReturnType<typeof select>>;
      try {
        selected = await select(podId);
      } catch (e) {
        if (store.forPod(podId)) cleanupConflict('Another request already owns this pod.');
        return { state: 'blocked', podId, blockers: [diagnostic(e, commonFallback)] };
      }
      const { plan } = selected.selection;
      if (
        plan.binding !== request.expectedBinding ||
        plan.generation !== request.expectedGeneration ||
        plan.sessionId !== request.expectedSessionId
      )
        cleanupConflict(
          'Reviewed cleanup selection is stale. Refresh preview; no effects were admitted.',
        );
      return execute(store.admit(podId, request, human, selected.selection, selected.guard));
    })().finally(() => flights.delete(request.id));
    flights.set(request.id, { hash, promise });
    return promise;
  }
  return { inspect, submit, receipt };
}
