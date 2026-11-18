import type { Pod } from '@autopod/shared';
import type { PodExecutionSettings } from '../interfaces/pod-execution-settings.js';
import type { WorktreeManager } from '../interfaces/worktree-manager.js';
import { inspectCheckpointSource } from '../worktrees/checkpoint-source-identity.js';
import { publishSource } from '../worktrees/durable-source-publication.js';
import type { PodRepository } from './pod-repository.js';
import { validationSourceError } from './validation-source-evidence.js';

/** The sole push replaces the old commit-and-push helper. Checked bytes never change here. */
export async function publishValidatedSource(input: {
  pod: Pod;
  profile: PodExecutionSettings;
  podRepo: PodRepository;
  worktreeManager: WorktreeManager;
  pat?: string;
  pushOptions?: { force?: boolean; expectedRemoteCommitSha?: string };
  assertCurrent(): void;
}) {
  const { pod, profile, podRepo, worktreeManager, assertCurrent } = input;
  const ledger = podRepo.sourcePublications;
  const repository = profile.repoUrl;
  const checked = podRepo.validationSources?.checked(pod, profile);
  if (!ledger || !repository || !checked)
    validationSourceError('Checked publication support is unavailable.');
  if (pod.prUrl) podRepo.mergeJournal?.assertPublicationAllowed?.(pod.prUrl);
  assertCurrent();
  let publishable: { head: string; tree: string; checkpoints: string[] } = {
    ...checked,
    checkpoints: [],
  };
  if (pod.executionTarget === 'sandbox') {
    publishable = await inspectCheckpointSource({
      podId: pod.id,
      worktreePath: pod.worktreePath ?? '',
      branch: pod.branch,
      head: checked.head,
      tree: checked.tree,
      worktreeManager,
      assertCurrent,
    });
  }
  const boundLedger = {
    ...ledger,
    assertDeliveryAllowed: (anchor: Pod, source: Parameters<typeof ledger.admit>[1]) => {
      if (!ledger.assertDeliveryAllowed)
        validationSourceError('Current delivery authority is unavailable.');
      ledger.assertDeliveryAllowed(anchor, source, checked.validationId);
    },
    admit: (anchor: Pod, source: Parameters<typeof ledger.admit>[1]) => {
      return ledger.admit(anchor, source, {
        validationId: checked.validationId,
        checkpoints: publishable.checkpoints,
      });
    },
  };
  const publication = await publishSource(
    boundLedger,
    pod,
    repository,
    worktreeManager,
    { ...input.pushOptions, pat: input.pat },
    (source) => {
      assertCurrent();
      podRepo.validationSources?.checked(pod, profile);
      if (
        source.commitSha !== publishable.head ||
        source.treeSha !== publishable.tree ||
        source.branch !== pod.branch ||
        !source.worktreeClean
      )
        validationSourceError('Source changed after checks; publication was not admitted.');
    },
  );
  assertCurrent();
  // Keep an observed push receipt even if checks changed while it was in
  // flight, but never carry that stale result into PR creation or delivery.
  podRepo.validationSources?.checked(pod, profile);
  return publication;
}
