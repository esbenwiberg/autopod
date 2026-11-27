import { z } from 'zod';

export const operatorDisposalRequestSchema = z
  .strictObject({
    requestKey: z.string().regex(/^[a-zA-Z0-9-]{1,64}$/),
    expectedGeneration: z.number().int().nonnegative(),
    intent: z.enum(['kill', 'delete']),
    acknowledgeDataLoss: z.literal(true).optional(),
  })
  .superRefine((r, ctx) => {
    if (r.intent === 'delete' && !r.acknowledgeDataLoss)
      ctx.addIssue({
        code: 'custom',
        path: ['acknowledgeDataLoss'],
        message: 'Delete permanently discards unpublished resources; acknowledge data loss.',
      });
  });
export type OperatorDisposalRequest = z.infer<typeof operatorDisposalRequestSchema>;
export interface OperatorDisposalReceipt {
  contract: 'operator-disposal-v1';
  podId: string;
  generation: number;
  requestKey: string;
  intent: 'kill' | 'delete';
  actor: { type: 'human'; userId: string };
  acceptedAt: string;
  scope: 'exact-pod-unpublished-resources';
  state: 'cleanup_pending' | 'stopped' | 'discarded';
  diagnostics: string[];
  resources?: Array<{
    kind: string;
    id: string;
    namespace: string;
    stopDispatched: boolean;
    discardDispatched: boolean;
    observedStopped: boolean;
    observedAbsent: boolean;
  }>;
}
