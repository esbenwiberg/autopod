import type { NativeGoalObservation } from '@autopod/shared';
import { z } from 'zod';

// Codex 0.152.1 generated app-server protocol; additional fields are forward compatible.
export const codexNativeGoalSchema = z.object({
  threadId: z.string().min(1),
  objective: z.string().min(1).max(4000),
  status: z.enum(['active', 'paused', 'blocked', 'usageLimited', 'budgetLimited', 'complete']),
  tokenBudget: z.number().int().nonnegative().nullable(),
  tokensUsed: z.number().int().nonnegative(),
  timeUsedSeconds: z.number().nonnegative(),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
});
export type CodexNativeGoal = z.infer<typeof codexNativeGoalSchema>;
export function codexGoalObservation(value: unknown, sequence: number): NativeGoalObservation {
  const goal = codexNativeGoalSchema.parse(value);
  const states = {
    active: 'active',
    paused: 'paused',
    blocked: 'blocked',
    usageLimited: 'paused',
    budgetLimited: 'budget-exhausted',
    complete: 'achieved',
  } as const;
  return {
    nativeSessionId: goal.threadId,
    objective: goal.objective,
    state: states[goal.status],
    nativeStatus: goal.status,
    sequence,
    cumulativeTokens: goal.tokensUsed,
    cumulativeSeconds: goal.timeUsedSeconds,
    ...(goal.status === 'usageLimited' ? { reason: 'Native provider usage limit reached' } : {}),
  };
}
