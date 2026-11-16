import { AutopodError } from '@autopod/shared';

export const GITHUB_DRAFT_REASON =
  'Pull request is still a draft. Mark it ready for review before merging.';

/** A diagnostic only: even this refusal cannot settle an admitted mutation. */
export class GitHubDraftMergeRefusal extends AutopodError {
  constructor() {
    super(GITHUB_DRAFT_REASON, 'GITHUB_DRAFT_MERGE_REFUSAL', 409);
  }
}

export function isGitHubDraftRefusal(error: unknown): boolean {
  const stderr = (error as { stderr?: unknown } | null)?.stderr;
  return (
    error instanceof Error &&
    typeof stderr === 'string' &&
    stderr.trim() === 'GraphQL: Pull Request is still a draft (mergePullRequest)'
  );
}
