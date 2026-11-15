import type { TaskExecutionSummary } from './types/task-execution.js';

/**
 * Cache reads count at one tenth of a token against task token limits. Providers bill
 * prompt-cache hits at roughly 0.1x the input price, and long agentic runs re-read
 * their context every turn. Cache creation keeps full weight, so a budget-counted
 * total never exceeds the raw recorded total: weighting only relaxes a limit.
 */
export const CACHE_READ_BUDGET_WEIGHT = 0.1;

/** Raw total with cache reads (a subset of input) counted at {@link CACHE_READ_BUDGET_WEIGHT}. */
export function cacheWeightedTokens(rawTotalTokens: number, cacheReadTokens: number): number {
  const raw = Math.max(0, rawTotalTokens);
  const reads = Number.isFinite(cacheReadTokens) ? Math.min(Math.max(0, cacheReadTokens), raw) : 0;
  return raw - reads + Math.ceil(reads * CACHE_READ_BUDGET_WEIGHT);
}

type BudgetUsage = Pick<
  TaskExecutionSummary,
  | 'recordedInputTokens'
  | 'recordedOutputTokens'
  | 'recordedTotalTokens'
  | 'recordedCachedInputTokens'
  | 'budgetCountedTokens'
>;

/** Raw recorded task total. Older daemon responses omit the canonical total. */
export function recordedTaskTokens(task: BudgetUsage): number {
  return task.recordedTotalTokens ?? task.recordedInputTokens + task.recordedOutputTokens;
}

/** Usage compared with the task token limit. Older daemon responses fall back to the raw total. */
export function budgetCountedTaskTokens(task: BudgetUsage): number {
  return task.budgetCountedTokens ?? recordedTaskTokens(task);
}

/** `used/limit` text that names discounted cache reads so the cause of exhaustion is visible. */
export function describeTaskBudgetUsage(task: BudgetUsage, limit: number | null): string {
  const counted = budgetCountedTaskTokens(task);
  const reads = task.recordedCachedInputTokens ?? 0;
  const head = `${counted}/${limit ?? 'no configured limit'}`;
  if (reads <= 0 || task.budgetCountedTokens === undefined) return `${head} tokens used`;
  return `${head} budget-counted tokens used; ${recordedTaskTokens(task)} recorded incl. ${reads} cache reads at ${CACHE_READ_BUDGET_WEIGHT}x`;
}

/** Operator command that raises the limit and approves a budget-paused pod in one step. */
export function budgetContinueCommand(podId: string): string {
  return `ap budget ${podId} <tokens> --continue`;
}

/**
 * One-line status for a pod paused on its soft token limit. The worker has
 * finished its turn; approval continues to validation. Usage is omitted when
 * task accounting is unavailable.
 */
export function describeBudgetPause(
  podId: string,
  task?: (BudgetUsage & { tokenBudget: number | null }) | null,
): string {
  const usage = task
    ? ` (${budgetCountedTaskTokens(task)}/${task.tokenBudget ?? 'no limit'} counted)`
    : '';
  return `Paused: token budget${usage}. Run: ${budgetContinueCommand(podId)}`;
}

/** Response to an accepted budget-pause approval. */
export interface BudgetContinuationResponse {
  ok: true;
  action: 'continue-budget';
  budgetExtensionsUsed: number;
  maxBudgetExtensions: number | null;
  /**
   * `started`: approval and the transition are recorded; validation runs in the
   * background. Follow pod status and events for the outcome.
   */
  validation: 'started' | 'finished';
}
