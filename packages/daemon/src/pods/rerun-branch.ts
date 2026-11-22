import type { Pod } from '@autopod/shared';

export interface RerunBranchSelection {
  /** The requested output branch when it is free; absent means admission auto-names it. */
  branch?: string;
  /** Other pods that still hold the requested branch (empty when it is free). */
  heldBy: string[];
}

/**
 * An intentional rerun keeps the source's requested output branch unless another
 * unfinished pod still holds it, or it names the base branch. The fallback is
 * deterministic: omit the branch so admission uses `${branchPrefix}${podId}`.
 * The rerun source itself does not hold its branch for this purpose.
 */
export function selectRerunBranch(input: {
  sourcePodId: string;
  requested: string | undefined;
  baseBranch: string;
  unfinished: Array<Pick<Pod, 'id' | 'branch'>>;
}): RerunBranchSelection {
  const { requested } = input;
  if (!requested) return { heldBy: [] };
  if (requested === input.baseBranch) return { heldBy: [] };
  const heldBy = input.unfinished
    .filter((pod) => pod.id !== input.sourcePodId && pod.branch === requested)
    .map((pod) => pod.id);
  return heldBy.length ? { heldBy } : { branch: requested, heldBy };
}
