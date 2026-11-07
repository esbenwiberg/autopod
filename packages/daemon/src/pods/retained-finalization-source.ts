import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Pod } from '@autopod/shared';
import type { WorktreeManager } from '../interfaces/worktree-manager.js';
import { inspectCheckpointSource } from '../worktrees/checkpoint-source-identity.js';
import { assertMergeRepository, sourceCommit } from '../worktrees/merge-source-identity.js';
import { safeAdoptionGit } from '../worktrees/source-adoption-git.js';
import type { ApprovalRewrite } from './approval-source-rewrite-repository.js';
import { rewriteHash } from './approval-source-rewrite-repository.js';
import type { PodRepository } from './pod-repository.js';
import type { CheckpointRecoveryRecord } from './retained-checkpoint-repository.js';
import { finalizationError } from './retained-finalization-repository.js';

export interface RetainedSourceAnchor {
  kind:
    | 'continuation-original'
    | 'continuation-selected'
    | 'rewrite-original'
    | 'rewrite-selected'
    | 'rewrite-repair';
  ownerId: string;
  repairId?: string;
  generation: number;
  worktreePath: string;
  repository: string;
  branch: string;
  head: string;
  /** Original legacy checkpoint bindings contain a commit but no tree. Resolve that exact Git object, never infer from another HEAD. */
  tree: string | null;
  checkedHead?: string;
  /** Original checkpoint/repair resource namespace is immutable even before finalization. */
  resourceKey?: string;
}

/** Relationship checks, not merely a hash of independent mutable/immutable facts. */
export function resolveRetainedSource(
  pods: PodRepository,
  pod: Pod,
  repository: string,
  baseBranch: string,
): RetainedSourceAnchor {
  const checkpoint = pods.retainedCheckpoints?.latest(pod.id);
  const rewrite = pods.approvalRewrites?.latest(pod);
  const repair = checkpoint?.binding.approvalRewrite;
  const originalRewrite = repair ? pods.approvalRewrites?.get(repair.id) : rewrite;
  if (repair) {
    if (
      !checkpoint ||
      !originalRewrite ||
      originalRewrite.aborted ||
      !originalRewrite.activated ||
      !originalRewrite.prepared ||
      originalRewrite.id !== rewrite?.id ||
      repair.evidenceHash !== rewriteHash(originalRewrite) ||
      repair.taskHash !== rewriteHash(pod.task) ||
      checkpoint.generation !== originalRewrite.activated.generation ||
      checkpoint.worktreePath !== originalRewrite.prepared.worktreePath ||
      checkpoint.binding.branch !== pod.branch
    )
      finalizationError('Rewrite repair is not bound to its immutable original owner.');
    if (checkpoint.activated) {
      if (rewrite.repairId !== checkpoint.id || !checkpoint.selected || !checkpoint.prepared)
        finalizationError('Activated repair has no exact selected source.');
      const anchor = checkpointAnchor(checkpoint, true);
      validateRewriteTarget(originalRewrite);
      return validate({
        ...anchor,
        kind: 'rewrite-repair',
        ownerId: originalRewrite.id,
        repairId: checkpoint.id,
      });
    }
    // Preparing a repair does not select it: the failed rewrite candidate still owns source.
    if (
      rewrite.repairId ||
      checkpoint.generation !== pod.lifecycleGeneration ||
      pod.containerId !== checkpoint.containerId
    )
      finalizationError('Unselected repair lifecycle changed.');
    return validate({ ...rewriteAnchor(originalRewrite), resourceKey: checkpoint.resourceKey });
  }
  if (checkpoint && !checkpoint.binding.continuation)
    finalizationError(
      'Unsupported checkpoint custody cannot supply finalization source authority.',
    );
  if (rewrite) {
    if (rewrite.repairId) finalizationError('Rewrite repair ownership is unavailable.');
    if (
      checkpoint &&
      (checkpoint.generation > rewrite.generation ||
        (checkpoint.activated && checkpoint.activated.generation > rewrite.generation))
    )
      finalizationError('Continuation and rewrite selections conflict.');
    return validate(rewriteAnchor(rewrite));
  }
  if (!checkpoint?.binding.continuation)
    finalizationError('No immutable retained source selection is available.');
  return validate(checkpointAnchor(checkpoint, false));

  function checkpointAnchor(
    record: CheckpointRecoveryRecord,
    isRepair: boolean,
  ): RetainedSourceAnchor {
    if (record.activated) {
      if (
        !record.prepared ||
        record.activated.generation !== record.generation + 1 ||
        (record.binding.continuation?.prepareOnly && !record.selected) ||
        (isRepair && !record.selected) ||
        pod.containerId === record.containerId
      )
        finalizationError(
          'Retained selection phase, generation or replacement resource is inconsistent.',
        );
      const selected =
        pods.retainedCoding?.finalSource(pod.id, record.activated.generation) ??
        record.infrastructure?.candidate ??
        record.selected ??
        record.prepared;
      if (record.checked?.snapshot && record.checked.snapshot.containerId !== pod.containerId)
        finalizationError('Current resource differs from the immutable checked-source snapshot.');
      if (record.checked?.source && record.checked.source.tree !== selected.tree)
        finalizationError('Checked repair source differs from its selected tree.');
      return {
        kind: 'continuation-selected',
        ownerId: record.id,
        generation: record.activated.generation,
        worktreePath: record.prepared.worktree,
        repository: record.binding.repository,
        branch: record.binding.branch,
        head: selected.head,
        tree: selected.tree,
        ...(record.checked?.source ? { checkedHead: record.checked.source.head } : {}),
      };
    }
    if (
      record.selected ||
      record.checking ||
      record.checked ||
      pod.containerId !== record.containerId
    )
      finalizationError('Unactivated continuation no longer owns its original resource.');
    return {
      kind: 'continuation-original',
      ownerId: record.id,
      generation: record.generation,
      worktreePath: record.worktreePath,
      repository: record.binding.repository,
      branch: record.binding.branch,
      head: record.binding.head,
      tree: record.prepared?.head === record.binding.head ? record.prepared.tree : null,
      resourceKey: record.resourceKey,
    };
  }
  function validateRewriteTarget(record: ApprovalRewrite) {
    if (
      record.aborted ||
      record.binding.prUrl !== pod.prUrl ||
      record.binding.predecessor.branch !== pod.branch ||
      record.binding.baseBranch !== baseBranch
    )
      finalizationError('Recorded rewrite PR/source/base authority changed.');
    assertMergeRepository(
      { repository, branch: pod.branch, baseBranch },
      record.binding.predecessor.repository,
    );
  }
  function rewriteAnchor(record: ApprovalRewrite): RetainedSourceAnchor {
    validateRewriteTarget(record);
    if (record.activated) {
      if (
        !record.prepared ||
        record.activated.generation !== record.generation + 1 ||
        (record.checked && record.checked.tree !== record.prepared.tree) ||
        (pod.containerId && pod.containerId === record.binding.containerId)
      )
        finalizationError('Rewrite selection phase or replacement resource is inconsistent.');
      return {
        kind: 'rewrite-selected',
        ownerId: record.id,
        generation: record.activated.generation,
        worktreePath: record.prepared.worktreePath,
        repository: record.binding.predecessor.repository,
        branch: record.binding.predecessor.branch,
        head: record.prepared.head,
        tree: record.prepared.tree,
        ...(record.checked ? { checkedHead: record.checked.head } : {}),
      };
    }
    if (record.checked || pod.containerId !== record.binding.containerId)
      finalizationError('Unactivated rewrite no longer owns its original resource.');
    return {
      kind: 'rewrite-original',
      ownerId: record.id,
      generation: record.generation,
      worktreePath: record.binding.worktreePath,
      repository: record.binding.predecessor.repository,
      branch: record.binding.predecessor.branch,
      head: record.binding.predecessor.commitSha,
      tree: record.binding.predecessor.treeSha,
    };
  }
  function validate(anchor: RetainedSourceAnchor) {
    if (
      anchor.generation !== pod.lifecycleGeneration ||
      anchor.worktreePath !== pod.worktreePath ||
      anchor.branch !== pod.branch ||
      !sourceCommit(anchor.head) ||
      (anchor.tree !== null && !sourceCommit(anchor.tree)) ||
      (anchor.checkedHead && !sourceCommit(anchor.checkedHead))
    )
      finalizationError(
        'Current generation/path/branch does not match the immutable retained source.',
      );
    assertMergeRepository({ repository, branch: pod.branch, baseBranch }, anchor.repository);
    return anchor;
  }
}

const exec = promisify(execFile);
export async function inspectRetainedSource(
  podId: string,
  anchor: RetainedSourceAnchor,
  manager: WorktreeManager,
  assertCurrent: () => void,
) {
  if (!manager.inspectSource) finalizationError('Clean retained source inspection is unavailable.');
  let tree = anchor.tree;
  if (!tree) {
    const git = safeAdoptionGit(async (args) => {
      assertCurrent();
      const result = await exec('git', args, {
        cwd: anchor.worktreePath,
        timeout: 15_000,
        maxBuffer: 1024 * 1024,
        env: {
          ...Object.fromEntries(
            Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')),
          ),
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_CONFIG_GLOBAL: '/dev/null',
          GIT_OPTIONAL_LOCKS: '0',
          GIT_TERMINAL_PROMPT: '0',
        },
      });
      assertCurrent();
      return result;
    });
    tree = (await git(['rev-parse', `${anchor.head}^{tree}`])).stdout.trim();
    if (!sourceCommit(tree))
      finalizationError('Immutable original source tree cannot be resolved.');
  }
  const lineage = await inspectCheckpointSource({
    podId,
    worktreePath: anchor.worktreePath,
    branch: anchor.branch,
    head: anchor.head,
    tree,
    worktreeManager: { inspectSourceAdoption: manager.inspectSource.bind(manager) },
    assertCurrent,
  });
  assertCurrent();
  if (
    anchor.checkedHead &&
    anchor.checkedHead !== anchor.head &&
    !lineage.checkpoints.includes(anchor.checkedHead)
  )
    finalizationError('Current source does not include the recorded checked checkpoint.');
  return {
    anchor: { ...anchor, tree },
    lineage,
    source: {
      branch: anchor.branch,
      commitSha: lineage.head,
      treeSha: lineage.tree,
      worktreeClean: true as const,
    },
  };
}
