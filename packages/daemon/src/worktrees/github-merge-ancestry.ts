import type {
  MergeAncestryProof,
  MergeAncestryRequest,
  PrMergeStatus,
} from '../interfaces/pr-manager.js';
import { assertMergeSource, assertMergeTarget, sourceCommit } from './merge-source-identity.js';

/** Read-only evidence for an already merged PR, never permission to mutate an open PR. */
export async function verifyGitHubMergedSourceAncestry(
  config: MergeAncestryRequest,
  observe: () => Promise<PrMergeStatus>,
  compare: (base: string, head: string) => Promise<unknown>,
): Promise<MergeAncestryProof | null> {
  const base = sourceCommit(config.publishedHeadSha);
  const head = sourceCommit(config.mergedHeadSha);
  if (!base || !head) return null;
  const check = (status: PrMergeStatus) => {
    if (!status.merged || status.open) return false;
    assertMergeSource(head, status.headSha);
    assertMergeTarget(config.expectedTarget, status.sourceTarget ?? {});
    return true;
  };
  if (!check(await observe())) return null;
  const result = (await compare(base, head)) as {
    status?: string;
    behind_by?: number;
    base_commit?: { sha?: string };
    merge_base_commit?: { sha?: string };
  } | null;
  // The request is addressed by full, immutable SHAs, not branch names. The
  // merge base must be exactly our source; neither equal trees nor a shared
  // older ancestor establish inclusion. No commit-list pagination is required.
  if (
    !result ||
    !['ahead', 'identical'].includes(result.status ?? '') ||
    result.behind_by !== 0 ||
    sourceCommit(result.base_commit?.sha) !== base ||
    sourceCommit(result.merge_base_commit?.sha) !== base
  )
    return null;
  if (!check(await observe())) return null;
  return {
    publishedHeadSha: base,
    mergedHeadSha: head,
    target: { ...config.expectedTarget },
    observedAt: new Date().toISOString(),
  };
}
