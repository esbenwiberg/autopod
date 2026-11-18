import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import type {
  OperatorActor,
  Pod,
  SavedWorkDraftCancel,
  SavedWorkDraftConfirm,
  SavedWorkDraftOperation,
  SavedWorkDraftPrepare,
  SavedWorkDraftPreview,
  SavedWorkSource,
} from '@autopod/shared';
import type { PodExecutionSettings } from '../interfaces/pod-execution-settings.js';
import type { PrManager, SavedDraftTarget } from '../interfaces/pr-manager.js';
import type { WorktreeManager } from '../interfaces/worktree-manager.js';
import { draftMarker, verifyDraftObservation } from '../worktrees/saved-work-draft-provider.js';
import {
  checkpointSavedSource,
  localSavedSource,
  prepareSavedSource,
  savedGit,
  verifySavedSource,
} from '../worktrees/saved-work-source.js';
import type { PodRepository } from './pod-repository.js';
import { finalizationSourceLocations } from './retained-finalization-repository.js';
import { draftError, draftHash } from './saved-work-draft-repository.js';
import { assertValidationMutationSettled } from './validation-recovery-policy.js';

export function createSavedWorkDraftPr(deps: {
  podRepo: PodRepository;
  executionForPod(pod: Pod): PodExecutionSettings;
  prManagerFactory?: (settings: PodExecutionSettings) => PrManager | null;
  worktreeManager: WorktreeManager;
  root: string;
  isIdle(podId: string): boolean;
  isGoal(podId: string): boolean;
  /** Existing publication security policy, applied only to the independent exact checkout. */
  scanPublication?(pod: Pod, worktree: string): Promise<void>;
  now?: () => number;
}) {
  const pods = deps.podRepo;
  const ledger = pods.savedWorkDrafts ?? draftError('Draft operation ledger unavailable.');
  const now = deps.now ?? Date.now;
  const human = (actor: OperatorActor) => {
    if (actor.type !== 'human' || !actor.userId?.trim())
      draftError(
        'Authenticated human required; managed grants and workers cannot publish saved work.',
      );
    return actor.userId;
  };
  function policy(pod: Pod) {
    if (
      pod.options.output !== 'pr' ||
      pod.options.agentMode !== 'auto' ||
      pod.completionPolicy === 'accept-findings' ||
      pods.validationExecutions?.hasGoal(pod.id) ||
      deps.isGoal(pod.id)
    )
      draftError('Only ordinary PR-output tasks support human saved-work draft publication.');
    if (
      !['failed', 'review_required', 'validated', 'complete', 'rejected', 'killed'].includes(
        pod.status,
      ) ||
      pod.pendingEscalation ||
      pods.hasUnansweredDecision?.(pod.id)
    )
      draftError('Task execution or a human decision is unsettled.');
    if (
      !pods.taskExecutions ||
      !pods.validationExecutions ||
      !pods.sourceAdoptions ||
      !pods.deletionOwnership
    )
      draftError('Execution/custody ledgers unavailable.');
    pods.taskExecutions.assertCanDelete(pod.id);
    if (pods.taskExecutions.hasUnverifiedTermination(pod.id))
      draftError('Worker termination is unverified.');
    pods.validationExecutions.assertNoActiveTaskExecution(pod.id);
    pods.validationExecutions.assertNoPendingRecovery(pod.id);
    assertValidationMutationSettled(pods, pod.id);
    pods.sourceAdoptions.assertControlPlaneSettled(pod.id);
    pods.deletionOwnership.assertTaskAvailable(pod.id);
    pods.stalledRecoveries?.assertAvailable(pod.id);
    pods.sandboxWakeups?.recovery.assertAvailable(pod.id);
    ledger.assertCustodySettled(pod.id);
    for (const id of new Set([pod.id, ...pods.sourceAdoptions.taskPodIds(pod.id)]))
      if (!deps.isIdle(id)) draftError('A worker, validation or control invocation is active.');
    const settings = deps.executionForPod(pod);
    if (
      (!pod.profileSnapshot && !pod.launchConfigDigest) ||
      !settings.repoUrl ||
      !pod.worktreePath ||
      !pod.branch
    )
      draftError('Frozen repository and saved host source are required.');
    const provider = deps.prManagerFactory?.(settings)?.savedDraft;
    if (
      !provider ||
      typeof provider.assertRepository !== 'function' ||
      !deps.worktreeManager.supportsCreateOnlyPublication ||
      !deps.worktreeManager.observeSourceBranch
    )
      draftError(
        'Provider does not support exact saved-work draft publication; nothing was pushed.',
      );
    provider.assertRepository(settings.repoUrl);
    const baseBranch = pod.baseBranch ?? settings.defaultBranch;
    if (!baseBranch) draftError('Frozen target branch unavailable.');
    return {
      settings,
      provider,
      repository: settings.repoUrl,
      baseBranch,
      worktree: pod.worktreePath,
      branch: pod.branch,
    };
  }
  function fingerprint(
    pod: Pod,
    sources: SavedWorkSource[],
    repository: string,
    baseBranch: string,
  ) {
    return draftHash([
      pod.id,
      pods.taskExecutions?.snapshot(pod.id).taskId,
      pod.lifecycleGeneration,
      pod.status,
      pod.task,
      pod.failureReason,
      pod.worktreePath,
      pod.containerId,
      pod.branch,
      pod.prUrl,
      pod.launchConfigDigest,
      pod.profileSnapshot,
      pod.options,
      pod.worktreeCompromised,
      pod.completionPolicy,
      pod.preSubmitReview,
      pod.lastValidationResult,
      pod.validationAttempts,
      pod.readinessReview,
      repository,
      baseBranch,
      sources,
    ]);
  }
  async function inspect(podId: string, actor: OperatorActor): Promise<SavedWorkDraftPreview> {
    human(actor);
    const pod = pods.getOrThrow(podId);
    const blockers: string[] = [];
    const sources: SavedWorkSource[] = [];
    const settings = deps.executionForPod(pod);
    const repository = settings.repoUrl ?? '';
    const baseBranch = pod.baseBranch ?? settings.defaultBranch ?? '';
    try {
      const p = policy(pod);
      await savedGit(p.worktree)(['check-ref-format', `refs/heads/${baseBranch}`]);
      const records = (await pods.savedWorkspaceCheckpoints?.list?.(podId)) ?? [];
      const latestSequence = records[0]?.sequence ?? 0;
      for (const record of records) {
        try {
          sources.push(
            await checkpointSavedSource(podId, p.worktree, repository, record, latestSequence),
          );
        } catch (error) {
          blockers.push(
            `Snapshot ${record.sequence} unavailable: ${error instanceof Error ? error.message : 'unverified proof'}`,
          );
        }
      }
      // Local HEAD is an explicitly selected host-only alternative, never a substitute for sandbox bytes.
      try {
        sources.push(await localSavedSource(p.worktree, repository, pod.branch));
      } catch (error) {
        blockers.push(
          `Host commit unavailable: ${error instanceof Error ? error.message : 'unverified source'}`,
        );
      }
      if (!sources.length)
        blockers.push(
          'No verified saved source. Capture source through an existing safe mechanism; this action never wakes or exports a sandbox.',
        );
      policy(pods.getOrThrow(podId));
    } catch (error) {
      blockers.unshift(error instanceof Error ? error.message : 'Draft publication unavailable');
    }
    const checks = [
      pod.lastValidationResult
        ? `Historical checks (exact snapshot applicability UNKNOWN; no new checks run):\n${JSON.stringify(pod.lastValidationResult, null, 2)}`
        : 'Validation NOT RUN. No checks certify this snapshot.',
      `Independent pre-submit review (historical; exact snapshot applicability UNKNOWN): ${JSON.stringify(pod.preSubmitReview ?? 'NOT RUN / UNKNOWN')}`,
    ].join('\n\n');
    return {
      podId,
      generation: pod.lifecycleGeneration,
      repository,
      baseBranch,
      sources,
      checks,
      blockers,
      binding: fingerprint(pod, sources, repository, baseBranch),
      operation: ledger.latest(podId),
    };
  }
  const checkout = (op: SavedWorkDraftOperation) => path.join(deps.root, op.id, 'worktree');
  function target(op: SavedWorkDraftOperation): SavedDraftTarget {
    return {
      repository: op.repository,
      branch: op.branch,
      baseBranch: op.baseBranch,
      head: op.source.commit,
      operationId: op.id,
      worktreePath: checkout(op),
    };
  }
  async function current(op: SavedWorkDraftOperation) {
    if (ledger.get(op.podId, op.requestId)?.state === 'cancelled')
      draftError('Draft operation cancelled; no publication is authorized.');
    const p = policy(pods.getOrThrow(op.podId));
    const preview = await inspect(op.podId, { type: 'human', userId: op.actorId });
    if (
      preview.binding !== op.previewBinding ||
      p.repository !== op.repository ||
      p.baseBranch !== op.baseBranch
    )
      draftError('Source, generation, repository, checks or task changed; confirmation is stale.');
    await verifySavedSource(p.worktree, op.repository, op.source);
    return p;
  }
  async function prepare(podId: string, request: SavedWorkDraftPrepare, actor: OperatorActor) {
    const actorId = human(actor);
    if (!/^[a-zA-Z0-9-]{1,64}$/.test(request.requestId)) draftError('Stable request ID required.');
    const existing = ledger.get(podId, request.requestId);
    if (existing) {
      if (
        existing.actorId !== actorId ||
        existing.previewBinding !== request.expectedBinding ||
        existing.source.id !== request.sourceId
      )
        draftError('Request ID is already bound to another actor or selection.');
      return existing; // Observe interrupted preparation; never replay filesystem writes.
    }
    const preview = await inspect(podId, actor);
    const pod = pods.getOrThrow(podId);
    const p = policy(pod);
    if (preview.binding !== request.expectedBinding) draftError('Preview changed; inspect again.');
    const source = preview.sources.find((s) => s.id === request.sourceId);
    if (!source) draftError('Explicit verified source selection required.');
    const id = randomUUID();
    const createdAt = new Date(now()).toISOString();
    const op: SavedWorkDraftOperation = {
      id,
      requestId: request.requestId,
      podId,
      actorId,
      generation: pod.lifecycleGeneration,
      taskId:
        pods.taskExecutions?.snapshot(podId).taskId ?? draftError('Task identity unavailable.'),
      originalWorktreePath: p.worktree,
      originalContainerId: pod.containerId,
      sourceLocations: finalizationSourceLocations([p.worktree]),
      previewBinding: preview.binding,
      confirmationBinding: '',
      repository: p.repository,
      baseBranch: p.baseBranch,
      branch: `autopod/saved-work/${podId}/${id}`,
      source,
      checks: preview.checks,
      createdAt,
      expiresAt: new Date(now() + 15 * 60_000).toISOString(),
      state: 'preparing',
      receipt: null,
      body: [
        draftMarker(id),
        'Saved work for human review only. This draft is not approval or successful task completion.',
        `Task ${podId}; status: ${pod.status}; failure: ${pod.failureReason ?? 'not recorded'}`,
        `Source: ${source.commit}\nTree: ${source.tree}\nCapture: ${source.capturedAt ?? 'unknown'} (${source.freshness})`,
        source.exclusions,
        preview.checks,
        'Original resources, checks, retry budgets and lifecycle are retained unchanged.',
      ].join('\n\n'),
    };
    op.confirmationBinding = draftHash(op);
    ledger.assertAvailable(podId);
    ledger.insert(op, request.requestId); // Fence original mutations before preparing independent source.
    try {
      await mkdir(deps.root, { recursive: true, mode: 0o700 });
      await current(op);
      await prepareSavedSource({
        worktree: p.worktree,
        repository: p.repository,
        source,
        root: path.join(deps.root, id),
        branch: op.branch,
        assertCurrent: () => {
          policy(pods.getOrThrow(podId));
          if (pods.getOrThrow(podId).lifecycleGeneration !== op.generation)
            draftError('Generation changed.');
        },
      });
      await current(op);
      return ledger.transition(op, 'prepared');
    } catch (error) {
      const saved =
        ledger.get(podId, request.requestId) ?? draftError('Preparation evidence unavailable.');
      if (saved.state === 'cancelled') return saved;
      if (saved.state !== 'preparing') throw error;
      return ledger.transition(
        saved,
        'cancelled',
        null,
        `Preparation failed before external admission: ${error instanceof Error ? error.message : 'unknown failure'}. All source and resources retained.`,
      );
    }
  }
  async function confirm(podId: string, request: SavedWorkDraftConfirm, actor: OperatorActor) {
    const actorId = human(actor);
    let op =
      ledger.get(podId, request.requestId) ??
      draftError('Prepare and preview this exact request first.');
    if (
      op.actorId !== actorId ||
      request.draftOnly !== true ||
      request.expectedBinding !== op.confirmationBinding
    )
      draftError('Exact human draft-only confirmation required.');
    if (op.state === 'published' || op.state === 'cancelled') return op;
    if (op.state === 'preparing')
      draftError('Preparation is unsettled; retain source and observe the same operation.');
    const p = await current(op);
    if (op.state === 'prepared') {
      if (now() > Date.parse(op.expiresAt))
        return ledger.transition(
          op,
          'cancelled',
          null,
          'Confirmation expired before external admission. All source and resources retained; inspect and select again.',
        );
      // Verify independent bytes before asking the authenticated adapter to admit one create-only push.
      const copy = await localSavedSource(checkout(op), op.repository, op.branch);
      if (copy.commit !== op.source.commit || copy.tree !== op.source.tree)
        draftError('Prepared checkout changed.');
      await current(op);
      await deps.scanPublication?.(pods.getOrThrow(podId), checkout(op));
      await current(op);
      try {
        await deps.worktreeManager.pushBranch(checkout(op), op.branch, {
          createOnly: true,
          expectedRepository: op.repository,
          beforePrepared: async () => {
            await current(op);
          },
          onPrepared(source) {
            policy(pods.getOrThrow(podId));
            // The scan and provider preflight may outlive the initial check.
            // Recheck the confirmation deadline before admitting any remote write.
            if (now() > Date.parse(op.expiresAt))
              draftError('Confirmation expired during publication checks; nothing was pushed.');
            if (
              source.commitSha !== op.source.commit ||
              source.treeSha !== op.source.tree ||
              source.branch !== op.branch
            )
              draftError('Push source differs from exact selection.');
            op = ledger.transition(op, 'push-uncertain'); // Durable admission before the sole write.
          },
        });
      } catch (error) {
        const saved =
          ledger.get(podId, request.requestId) ?? draftError('Operation evidence missing.');
        if (saved.state === 'prepared') throw error;
        return saved;
      }
      op = ledger.get(podId, request.requestId) ?? draftError('Push admission evidence missing.');
      if (op.state !== 'push-uncertain') {
        if (['pushed', 'create-uncertain', 'published'].includes(op.state)) return op;
        draftError('Adapter did not record create-only admission.');
      }
      await current(op);
      op = ledger.transition(op, 'pushed');
    } else if (op.state === 'push-uncertain') {
      // An admitted branch write may have succeeded. A negative read never permits replay.
      let observed: string;
      try {
        observed = await (
          deps.worktreeManager.observeSourceBranch ??
          draftError('Read-only remote observation unsupported.')
        )(checkout(op), op.repository, op.branch);
      } catch {
        return op;
      }
      await current(op);
      if (observed !== op.source.commit) return op;
      op = ledger.transition(op, 'pushed');
    }
    const t = target(op);
    await current(op);
    const found = await p.provider.find(t);
    await current(op);
    if (found) {
      if (op.state !== 'create-uncertain')
        draftError('Existing PR has no operation create admission.');
      return ledger.transition(op, 'published', verifyDraftObservation(t, found));
    }
    if (op.state === 'create-uncertain') return op; // No replay after timeout, even with negative lookup.
    if (op.state !== 'pushed') return op;
    await current(op);
    try {
      await p.provider.create(t, op.body, async () => {
        await current(op);
        const remote = await deps.worktreeManager.observeSourceBranch?.(
          checkout(op),
          op.repository,
          op.branch,
        );
        await current(op);
        if (remote !== op.source.commit)
          draftError('Operation-owned remote branch changed; no PR creation admitted.');
        policy(pods.getOrThrow(podId));
        op = ledger.transition(op, 'create-uncertain');
      });
    } catch {
      return ledger.get(podId, request.requestId) ?? draftError('Operation evidence missing.');
    }
    await current(op);
    op = ledger.get(podId, request.requestId) ?? draftError('Create admission evidence missing.');
    if (op.state === 'published') return op;
    if (op.state !== 'create-uncertain')
      draftError('Provider did not record exact create admission.');
    const result = await p.provider.find(t);
    await current(op);
    return result ? ledger.transition(op, 'published', verifyDraftObservation(t, result)) : op;
  }
  async function observe(podId: string, requestId: string, actor: OperatorActor) {
    const actorId = human(actor);
    let op =
      ledger.get(podId, requestId) ??
      draftError(
        'No operation recorded for this request; absence does not authorize resubmission.',
      );
    if (op.actorId !== actorId) draftError('Operation belongs to another human.');
    if (
      op.state === 'published' ||
      op.state === 'cancelled' ||
      op.state === 'preparing' ||
      op.state === 'prepared' ||
      op.state === 'pushed'
    )
      return op;
    const p = await current(op);
    if (op.state === 'push-uncertain') {
      try {
        const head = await deps.worktreeManager.observeSourceBranch?.(
          checkout(op),
          op.repository,
          op.branch,
        );
        await current(op);
        if (head === op.source.commit) op = ledger.transition(op, 'pushed');
      } catch {
        /* Unknown/negative is never replay authority. */
      }
      return op;
    }
    const found = await p.provider.find(target(op));
    await current(op);
    return found
      ? ledger.transition(op, 'published', verifyDraftObservation(target(op), found))
      : op;
  }
  function cancel(podId: string, request: SavedWorkDraftCancel, actor: OperatorActor) {
    const actorId = human(actor);
    const op = ledger.get(podId, request.requestId) ?? draftError('No saved operation.');
    if (op.actorId !== actorId || op.confirmationBinding !== request.expectedBinding)
      draftError('Exact actor-bound cancellation required.');
    if (op.state === 'cancelled') return op;
    if (op.state !== 'preparing' && op.state !== 'prepared')
      draftError(
        'An external effect was admitted; cancellation cannot release custody. Observe this operation.',
      );
    return ledger.transition(
      op,
      'cancelled',
      null,
      'Human cancelled before external admission. All source, independent preparation files and original resources retained.',
    );
  }
  function cancelPreparation(podId: string, request: SavedWorkDraftPrepare, actor: OperatorActor) {
    const actorId = human(actor);
    if (
      !/^[a-zA-Z0-9-]{1,64}$/.test(request.requestId) ||
      !/^[a-f0-9]{64}$/.test(request.expectedBinding) ||
      !request.sourceId ||
      request.sourceId.length > 160
    )
      draftError('Exact pending preparation request required.');
    pods.getOrThrow(podId);
    return ledger.cancelPreparation(podId, request, actorId);
  }
  return { inspect, prepare, confirm, observe, cancel, cancelPreparation };
}
