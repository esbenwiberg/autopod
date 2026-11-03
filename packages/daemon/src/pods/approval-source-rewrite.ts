import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { Pod } from '@autopod/shared';
import { atomicPodChange } from '../db/unit-of-work.js';
import type { PodExecutionSettings } from '../interfaces/pod-execution-settings.js';
import type { WorktreeManager } from '../interfaces/worktree-manager.js';
import { inspectCheckpointSource } from '../worktrees/checkpoint-source-identity.js';
import type { ConfirmedSourcePublication } from '../worktrees/durable-source-publication.js';
import type { ApprovalDeliveryExecutionCaptured } from './approval-contracts.js';
import { rewriteError, rewriteHash } from './approval-source-rewrite-repository.js';
import type { PodRepository } from './pod-repository.js';
import { getPodValidationSkipPhases } from './validation-workflow-policy.js';

export const rewriteConfiguration = (pod: Pod, profile: PodExecutionSettings) =>
  rewriteHash([
    pod.launchConfigDigest,
    pod.branch,
    pod.baseBranch,
    pod.options,
    pod.runtime,
    pod.model,
    pod.contract,
    profile,
  ]);

/** Prepare only an isolated candidate. The approved source and original resource never move. */
export async function prepareApprovalRewrite(
  captured: ApprovalDeliveryExecutionCaptured,
  pod: Pod,
  publication: ConfirmedSourcePublication,
  baseBranch: string,
  pat: string | undefined,
): Promise<string | null> {
  const { podRepo, worktreeManager } = captured;
  const repo = podRepo.approvalRewrites ?? rewriteError('Rewrite ledger unavailable.');
  if (!worktreeManager.prepareApprovalRebase) rewriteError('Isolated rebase support unavailable.');
  const saved = repo.latest(pod);
  if (saved?.prepared && !saved.activated) {
    if (
      saved.binding.configurationHash !==
        rewriteConfiguration(pod, captured.executionForPod(pod)) ||
      saved.binding.validationHash !== rewriteHash(pod.lastValidationResult) ||
      saved.binding.predecessor.commitSha !== publication.commitSha ||
      saved.binding.predecessor.treeSha !== publication.treeSha ||
      saved.binding.publicationId !== publication.publicationId
    )
      rewriteError('Saved rebase candidate no longer matches the approved predecessor.');
    const source = await worktreeManager.inspectSource?.(saved.prepared.worktreePath, pod.branch);
    captured.assertApprovalCurrent(pod);
    if (
      !source?.worktreeClean ||
      source.branch !== pod.branch ||
      source.commitSha !== saved.prepared.head ||
      source.treeSha !== saved.prepared.tree
    )
      rewriteError('Saved isolated candidate changed before activation.');
    return saved.id;
  }
  const id = randomUUID();
  const parent = path.resolve(
    process.env.DATA_DIR ?? path.join(process.cwd(), '.autopod-data'),
    'approval-rewrites',
    pod.id.replace(/[^a-zA-Z0-9_-]/g, '_'),
  );
  const root = path.join(parent, id);
  const assertCurrent = () => captured.assertApprovalCurrent(pod);
  assertCurrent();
  await mkdir(parent, { recursive: true, mode: 0o700 });
  assertCurrent();
  const result = await worktreeManager
    .prepareApprovalRebase({
      worktreePath: pod.worktreePath ?? rewriteError('Original worktree unavailable.'),
      branch: pod.branch,
      baseBranch,
      repository: publication.repository,
      head: publication.commitSha,
      tree: publication.treeSha,
      root,
      generation: pod.lifecycleGeneration,
      cycle: pod.finalization?.cycle ?? 0,
      pat,
      assertCurrent,
      onPrepared(baseCommitSha) {
        assertCurrent();
        // A rewrite never grants another try at an unknown merge request.
        if (pod.prUrl) podRepo.mergeJournal?.assertPublicationAllowed?.(pod.prUrl);
        const merge = podRepo.mergeJournal?.find(pod);
        if (merge && (merge.state === 'admitted' || merge.result?.autoMergeScheduled))
          rewriteError('An earlier merge request is unresolved.');
        if (
          captured.isGoal?.(pod.id) ||
          pod.options.validationSuite === 'thin' ||
          getPodValidationSkipPhases(captured.executionForPod(pod), pod).includes('review') ||
          pod.skipValidation ||
          pod.validationWaiver ||
          (pod.validationOverrides?.length ?? 0) > 0 ||
          pod.options.validate === false ||
          pod.linkedPodId ||
          pod.pendingEscalation ||
          (pod.sidecarContainerIds && Object.keys(pod.sidecarContainerIds).length > 0)
        )
          rewriteError(
            'Automatic rebase checks require an ordinary task with independent review, without waivers, sidecars or pending decisions. Native Goals retain their own revision workflow.',
          );
        repo.admit(id, pod, {
          predecessor: publication,
          publicationId: publication.publicationId,
          baseBranch,
          baseCommitSha,
          prUrl: pod.prUrl ?? rewriteError('PR identity unavailable.'),
          worktreePath: pod.worktreePath ?? rewriteError('Source unavailable.'),
          containerId: pod.containerId,
          configurationHash: rewriteConfiguration(pod, captured.executionForPod(pod)),
          validationHash: rewriteHash(pod.lastValidationResult),
          root,
        });
      },
    })
    .catch((error: unknown) => {
      assertCurrent();
      if (repo.get(id)) {
        captured.logger.warn(
          { err: error, podId: pod.id, rewriteId: id },
          'Isolated rebase preparation remains retained',
        );
        rewriteError(
          `Rewrite ${id} was admitted but preparation is not certified. Inspect source-recovery rather than repeating the operation.`,
        );
      }
      throw error;
    });
  assertCurrent();
  const original = await worktreeManager.inspectSource?.(pod.worktreePath ?? '', pod.branch);
  assertCurrent();
  if (
    !original?.worktreeClean ||
    original.branch !== pod.branch ||
    original.commitSha !== publication.commitSha ||
    original.treeSha !== publication.treeSha
  )
    rewriteError('Original source changed while preparing the base update.');
  if (result.kind === 'unchanged') return null;
  const record = repo.get(id) ?? rewriteError('Rebase candidate was not admitted.');
  if (result.baseCommitSha !== record.binding.baseCommitSha) rewriteError('Fetched base changed.');
  if (result.kind === 'conflict') {
    repo.append(id, 'aborted', {
      reason: captured.formatRebaseConflictReason(baseBranch, result.conflicts),
    });
    rewriteError(captured.formatRebaseConflictReason(baseBranch, result.conflicts));
  }
  if (
    result.worktreePath !== path.join(root, 'worktree') ||
    !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(result.head) ||
    !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(result.tree)
  )
    rewriteError('Candidate source namespace or identity changed.');
  repo.append(id, 'prepared', {
    worktreePath: result.worktreePath,
    head: result.head,
    tree: result.tree,
  });
  return id;
}

/** Commit selection before enqueue. Normal skipAgent provisioning runs checks, never a coding worker. */
export function activateApprovalRewrite(
  captured: ApprovalDeliveryExecutionCaptured,
  pod: Pod,
  id: string,
) {
  const repo = captured.podRepo.approvalRewrites ?? rewriteError('Rewrite ledger unavailable.');
  const record = repo.get(id) ?? rewriteError('Rewrite admission unavailable.');
  const prepared = record.prepared ?? rewriteError('Candidate unavailable.');
  atomicPodChange(captured.podRepo, () => {
    captured.assertApprovalCurrent(pod);
    if (
      record.activated ||
      record.generation !== pod.lifecycleGeneration ||
      record.binding.validationHash !== rewriteHash(pod.lastValidationResult)
    )
      rewriteError('Rewrite selection changed.');
    const validated = captured.transition(pod, 'validated');
    const generation = captured.podRepo.incrementLifecycleGeneration(pod.id);
    captured.podRepo.update(pod.id, {
      worktreePath: prepared.worktreePath,
      recoveryWorktreePath: prepared.worktreePath,
      containerId: null,
      skipAgent: true,
      autoApprove: false,
      lastValidationResult: null,
      preSubmitReview: null,
      validationWaiver: null,
      readinessReview: null,
      artifactsPath: null,
      previewUrl: null,
      failureReason: null,
      lastRecoveryTrigger: null,
      lastCorrectionMessage: null,
      infrastructureFailure: null,
      claudeSessionId: null,
      codexSessionId: null,
      piSessionId: null,
      startCommitSha: record.binding.baseCommitSha,
    });
    repo.append(id, 'activated', { generation });
    captured.transition({ ...validated, lifecycleGeneration: generation }, 'queued');
  });
  captured.emitActivityStatus(
    pod.id,
    'Base changed — rebased source queued for fresh validation and review only. A new approval is required; original source and reports remain retained.',
  );
  captured.enqueueSession(pod.id);
}

export async function verifyApprovalRewriteSource(
  podRepo: PodRepository,
  pod: Pod,
  manager: WorktreeManager,
  assertCurrent: () => void,
) {
  const row = podRepo.approvalRewrites?.latest(pod);
  if (!row?.activated || !row.prepared || row.activated.generation !== pod.lifecycleGeneration)
    rewriteError('No current candidate checks selection exists.');
  if (pod.worktreePath !== row.prepared.worktreePath) rewriteError('Candidate worktree changed.');
  const source = await inspectCheckpointSource({
    podId: pod.id,
    worktreePath: row.prepared.worktreePath,
    branch: pod.branch,
    head: row.prepared.head,
    tree: row.prepared.tree,
    worktreeManager: manager,
    assertCurrent,
  });
  return { row, source };
}
