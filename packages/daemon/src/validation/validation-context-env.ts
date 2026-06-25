export interface ValidationContextEnvInput {
  podId: string;
  headBranch: string;
  baseBranch: string;
  startCommitSha?: string | null;
}

function originRef(branch: string): string {
  return branch.startsWith('origin/') || branch.startsWith('refs/') ? branch : `origin/${branch}`;
}

function nonEmpty(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * Environment exposed to all validation shell commands.
 *
 * AUTOPOD_VALIDATION_BASE_REF is the diff-scoped base for this pod's own work:
 * for resumed/series/fix pods it is the persisted start commit when available,
 * otherwise it falls back to the PR base ref. AUTOPOD_PR_BASE_REF remains the
 * branch ref the eventual PR targets.
 */
export function buildValidationContextEnv(
  input: ValidationContextEnvInput,
): Record<string, string> {
  const prBaseRef = originRef(input.baseBranch);
  const startCommitSha = nonEmpty(input.startCommitSha);

  return {
    AUTOPOD_POD_ID: input.podId,
    AUTOPOD_HEAD_BRANCH: input.headBranch,
    AUTOPOD_BASE_BRANCH: input.baseBranch,
    AUTOPOD_PR_BASE_REF: prBaseRef,
    AUTOPOD_VALIDATION_BASE_REF: startCommitSha ?? prBaseRef,
    ...(startCommitSha ? { AUTOPOD_START_COMMIT_SHA: startCommitSha } : {}),
  };
}
