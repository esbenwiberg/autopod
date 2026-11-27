import {
  AutopodError,
  type OperatorActor,
  type OperatorDisposalReceipt,
  type OperatorDisposalRequest,
} from '@autopod/shared';
import type { RetainedCleanupDocker } from '../containers/retained-cleanup-docker.js';
import { gitWorktreeIdentity } from '../worktrees/allocation-identity.js';
import {
  createRetainedCleanupHost,
  qualifyRetainedGit,
  type RetainedCleanupHost,
} from '../worktrees/retained-cleanup-host.js';
import type { PodRepository } from './pod-repository.js';
import type { Target } from './retained-cleanup-repository.js';

/** Intent admission never depends on physical cleanup eligibility. No PodStatus is rewritten. */
export function createOperatorDisposal(deps: {
  pods: PodRepository;
  docker?: RetainedCleanupDocker;
  host?: RetainedCleanupHost;
}) {
  const { pods, docker } = deps;
  const store = pods.operatorDisposals!;
  const host = deps.host ?? createRetainedCleanupHost();
  const flights = new Map<string, Promise<OperatorDisposalReceipt>>();
  const pending = (message: string): never => {
    throw new AutopodError(message, 'DISPOSAL_CLEANUP_PENDING', 409);
  };
  async function reconcile(id: string, key: string): Promise<OperatorDisposalReceipt> {
    const receipt = store.receipt(id, key) ?? pending('No disposal receipt exists.');
    if (receipt.state !== 'cleanup_pending') return receipt;
    const subject = store.subject(id, key);
    const guard = () => {
      if (store.receipt(id)?.requestKey !== key)
        pending('A later explicit disposition supersedes this cleanup attempt.');
      const p = pods.getOrThrow(id);
      if (
        p.lifecycleGeneration !== receipt.generation ||
        p.containerId !== subject.container_id ||
        p.worktreePath !== subject.worktree_path
      )
        pending('Exact subject identity changed; no replacement target is inferred.');
    };
    try {
      guard();
      const p = pods.getOrThrow(id);
      if (
        !docker ||
        !pods.retainedCleanup ||
        !pods.retainedFinalizations ||
        p.executionTarget !== 'local'
      )
        pending(
          'Backend lacks independently verified exact cleanup support. Intent is durable; cleanup remains pending.',
        );
      const history = pods.retainedCleanup.heldHistory(id);
      const context = pods.retainedCleanup.context(id);
      if (
        context.unsettled ||
        history.extra.length ||
        context.incompatible ||
        context.lineage.length ||
        history.members.length !== 1 ||
        p.linkedPodId ||
        p.fixPodId ||
        p.dependsOnPodId ||
        p.dependsOnPodIds.length ||
        p.requireSidecars?.length ||
        Object.keys(p.sidecarContainerIds ?? {}).length ||
        p.testRunBranches?.length ||
        p.recoveryWorktreePath ||
        p.profileSnapshot?.testPipeline
      )
        pending(
          'Additional execution, linkage or recovery custody requires separate exact closure evidence.',
        );
      if (!p.containerId || !p.worktreePath || !p.branch)
        pending(
          'Complete physical resource inventory is unavailable. Absence is not inferred from missing pod fields.',
        );
      const prior = pods.retainedFinalizations.historicalClaims(id);
      if (prior.sourceLocations.some((v) => v !== p.worktreePath))
        pending('Historical source locations exceed the selected checkout.');
      // Include earlier workers: a validation-only retry can replace Docker without changing generation.
      const ids = new Set([p.containerId, ...prior.resources]);
      for (const w of history.workers) {
        const b = JSON.parse(w.binding);
        if (
          w.generation !== receipt.generation ||
          b.resource?.executionTarget !== 'local' ||
          !b.resource?.containerId
        )
          pending('Historical worker resource identity is incomplete.');
        ids.add(b.resource.containerId);
      }
      for (const d of history.dispatches) {
        const b = JSON.parse(d.binding);
        if (
          b.executionTarget !== 'local' ||
          b.worktreePath !== p.worktreePath ||
          b.generation !== receipt.generation ||
          !b.containerId
        )
          pending('Historical validation topology is not covered.');
        ids.add(b.containerId);
      }
      const saved = store.hasEvent(id, key, 'targets');
      // A restart observes saved immutable targets rather than rediscovering or replaying an effect.
      let targets: Target[];
      if (saved) {
        targets = store.targets(id, key)!;
      } else {
        const git = await gitWorktreeIdentity(p.worktreePath, 'shared-cache', undefined, p.branch);
        guard();
        qualifyRetainedGit(git);
        targets = [
          {
            kind: 'host_worktree',
            role: 'original_checkout',
            id: git.worktree.path,
            namespace: [git.worktree.device, git.worktree.inode, git.worktree.birthtimeNs].join(
              ':',
            ),
            git,
          },
        ];
        for (const cid of ids)
          targets.push(...(await docker.discover(id, cid, p.worktreePath, guard)));
        targets = targets.filter(
          (t, i, all) => all.findIndex((q) => q.kind === t.kind && q.id === t.id) === i,
        );
        for (const a of history.allocations) {
          const e = a.evidence && JSON.parse(a.evidence);
          if (
            a.kind !== 'owned' ||
            a.generation !== receipt.generation ||
            !e ||
            (a.role === 'original-worktree'
              ? e.worktree?.path !== p.worktreePath
              : !targets.some((t) => t.id === e.id && t.namespace === e.engineId))
          )
            pending('An allocation or predecessor lacks exact closure evidence.');
        }
        guard();
        store.event(id, key, 'targets', targets);
      }
      const exact = () => {
        guard();
        pods.retainedCleanup!.assertForeignClaims(id, [...ids], [p.worktreePath!]);
        for (const cid of ids) {
          pods.validationExecutions!.assertResourceUnshared(id, cid);
          pods.rewriteAbandonments!.assertUnshared(id, cid, [p.worktreePath!]);
        }
        for (const a of pods.retainedCleanup!.foreignAllocations(context.membership!.task_id)) {
          const e = a.evidence && JSON.parse(a.evidence);
          if (e && targets.some((t) => t.namespace === e.engineId && t.id === e.id))
            pending('Foreign allocation claims an exact target.');
        }
        pods.retainedCleanup!.assertAllocationTransportsSettled(
          targets.filter((t) => t.kind === 'docker_bridge').map((t) => t.name),
          [p.worktreePath!],
        );
        // External effects already admitted remain in their original ledgers; never replay them.
        for (const cid of ids) pods.externalDeliveries?.assertReleasable(cid);
      };
      exact();
      await host.proof(targets, exact, true);
      await docker.proof(targets, exact, true);
      for (const t of targets.filter((t) => t.kind === 'docker_container')) {
        const selection = targets.filter((q) => q.kind !== 'docker_container' || q.id === t.id);
        if (!(await docker.stopped(selection, exact))) {
          if (store.hasEvent(id, key, 'stop:' + t.id))
            pending('A stop was dispatched but independent closure is still unknown; no replay.');
          exact();
          store.event(id, key, 'stop:' + t.id, { target: t });
          try {
            await docker.stop(selection, exact);
          } catch {
            /* Observe independently even after a lost reply. */
          }
          if (!(await docker.stopped(selection, exact)))
            pending('Execution stop is not independently confirmed.');
        }
      }
      if (receipt.intent === 'kill') {
        store.event(id, key, 'complete', { state: 'stopped' });
      } else {
        const ordered = [...targets].sort(
          (a, b) =>
            ['docker_container', 'docker_bridge', 'host_worktree', 'host_prepared_root'].indexOf(
              a.kind,
            ) -
            ['docker_container', 'docker_bridge', 'host_worktree', 'host_prepared_root'].indexOf(
              b.kind,
            ),
        );
        for (const t of ordered) {
          const absent = t.kind.startsWith('docker_')
            ? await docker.proof(targets, exact)
            : await host.proof(targets, exact, true);
          if (absent.has(t.id)) continue;
          const dispatch = () => {
            exact();
            if (store.hasEvent(id, key, 'remove:' + t.id)) return false;
            store.event(id, key, 'remove:' + t.id, { target: t });
            return true;
          };
          try {
            if (t.kind === 'docker_container' || t.kind === 'docker_bridge')
              await docker.remove(t, exact, dispatch);
            else await host.remove(t, targets, exact, dispatch, exact);
          } catch {
            /* A transport reply is not an absence receipt. */
          }
          const after = t.kind.startsWith('docker_')
            ? await docker.proof(targets, exact)
            : await host.proof(targets, exact, true);
          if (!after.has(t.id))
            pending('Partial or unknown discard; inspect recorded exact dispatches. No replay.');
        }
        store.event(id, key, 'complete', { state: 'discarded' });
      }
    } catch (error) {
      store.event(id, key, 'diagnostic', {
        message:
          error instanceof AutopodError
            ? error.message
            : 'Exact ownership or physical closure observation failed; retained diagnostics require inspection.',
      });
    }
    return store.receipt(id, key)!;
  }
  function observe(id: string, key: string) {
    const token = id + ':' + key;
    const running = flights.get(token);
    if (running) return running;
    const promise = reconcile(id, key).finally(() => flights.delete(token));
    flights.set(token, promise);
    return promise;
  }
  return {
    submit(id: string, request: OperatorDisposalRequest, actor: OperatorActor) {
      store.accept(id, request, { type: 'human', userId: actor.userId });
      // Return acceptance immediately. Physical effects run only after durable intent.
      void observe(id, request.requestKey);
      return store.receipt(id, request.requestKey)!;
    },
    observe,
  };
}
