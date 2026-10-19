import type { Pod } from '@autopod/shared';
import type { PodExecutionSettings } from '../interfaces/pod-execution-settings.js';

export function formatRebaseConflictReason(
  baseBranch: string,
  conflicts: readonly string[],
): string {
  const preview = conflicts.slice(0, 5).join(', ');
  const ellipsis = conflicts.length > 5 ? '…' : '';
  return `Rebase conflicts on ${baseBranch}: ${preview || '(see logs)'}${ellipsis}`;
}

export function resolvePrBaseBranch(pod: Pod, profile: PodExecutionSettings): string {
  const fallback = profile.defaultBranch ?? 'main';
  const candidate = pod.baseBranch ?? fallback;
  if (candidate !== pod.branch) return candidate;
  if (fallback !== pod.branch) return fallback;
  return pod.branch === 'main' ? candidate : 'main';
}

export function isSinglePrSeriesPod(pod: Pick<Pod, 'prMode' | 'seriesId'>): boolean {
  return pod.prMode === 'single' && Boolean(pod.seriesId);
}
