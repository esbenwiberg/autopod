import type { GitHubAccessPreset, ResolvedGitHubRule } from './launch-config.js';

export type GitHubOperation = GitHubAccessPreset['rules'][number]['operations'][number];
export interface GitHubRepositoryIdentity {
  id: string;
  ownerId: string;
  ownerLogin: string;
  name: string;
  defaultBranch: string;
}
/** Authoritative metadata fetched by the daemon, never accepted from the pod. */
export interface GitHubOperationResource {
  repository: GitHubRepositoryIdentity;
  issue?: { number: number; isPullRequest: boolean };
  workflow?: { repositoryId: string; id: string; path: string; branch: string | null };
}
export interface GitHubPolicyDecision {
  snapshotRuleId: string;
  ceilingRuleId: string;
}
export interface GitHubOperationPolicy {
  snapshot: ResolvedGitHubRule[];
  currentCeiling: ResolvedGitHubRule[];
}
