import type { CodeIntelligenceConfig } from '@autopod/shared';

/**
 * Per-project state directories that daemon-injected MCP code-intel servers
 * write into `/workspace`. These are container-local caches: they have no
 * meaning on the host, but `git add -A` happily picks them up.
 *
 * The failure mode is the deletion-guard loop: pod A's agent runs
 * `git add -A && git commit` (per system-instructions-generator.ts), sweeping
 * `.serena/project.yml` and friends into the feature branch. Pod B's container
 * starts fresh — no `.serena/` yet — and after sync-back, the host worktree
 * sees those tracked files as deletions. `commitPendingChanges` with
 * `maxDeletions: 0` then refuses the commit and flips the pod into
 * `worktreeCompromised`. We've seen this fire repeatedly in practice.
 *
 * The fix is two-layer:
 *   1. Inside the container, write these paths to `.git/info/exclude` and
 *      `git rm --cached -r --ignore-unmatch` them so the agent's own
 *      `git add -A` can never re-track them.
 *   2. On the host, exclude them from `stageAllChanges` so a sync-back that
 *      happens to drop the files can't be perceived as a deletion event.
 *
 * Gated on `profile.codeIntelligence` so non-code-intel pods see no behavior
 * change.
 */
export function agentToolingCachePaths(
  config: CodeIntelligenceConfig | null | undefined,
): string[] {
  if (!config) return [];
  const paths: string[] = [];
  if (config.serena) paths.push('.serena');
  if (config.roslynCodeLens) paths.push('.roslyn-codelens');
  return paths;
}
