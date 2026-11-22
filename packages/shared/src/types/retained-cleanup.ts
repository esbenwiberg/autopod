import { z } from 'zod';

export const retainedCleanupRequestIdSchema = z.string().regex(/^[a-zA-Z0-9-]{1,64}$/);

export const retainedCleanupRequestSchema = z.strictObject({
  id: retainedCleanupRequestIdSchema,
  expectedGeneration: z.number().int().positive(),
  expectedBinding: z.string().regex(/^[a-f0-9]{64}$/),
  expectedSessionId: z.string().min(1).max(128),
  reason: z.string().trim().min(10).max(4000),
  acknowledgeDataLoss: z.literal(true),
});

export type RetainedCleanupRequest = z.infer<typeof retainedCleanupRequestSchema>;

export type RetainedCleanupBlocker = {
  code:
    | 'UNSUPPORTED_HISTORY'
    | 'UNSUPPORTED_TOPOLOGY'
    | 'UNAVAILABLE'
    | 'EXECUTION_NOT_STOPPED'
    | 'FOREIGN_ATTACHMENT'
    | 'HOST_PROOF_UNAVAILABLE'
    | 'NOT_SETTLED'
    | 'PENDING_STOP'
    | 'OWNERSHIP_CONFLICT'
    | 'IDENTITY_CHANGED'
    | 'OBSERVATION_UNAVAILABLE'
    | 'REMOVAL_UNCONFIRMED'
    | 'FLEET_REMOVAL_UNCONFIRMED';
  message: string;
  resourceId?: string;
};

export type RetainedCleanupResource = {
  kind: 'docker_container' | 'docker_bridge' | 'host_worktree' | 'host_prepared_root';
  role:
    | 'guest_execution'
    | 'owned_bridge'
    | 'original_checkout'
    | 'prepared_checkout'
    | 'private_prepared_source';
  /** Exact identity within the bound provider namespace; never a Docker name. */
  id: string;
  namespace: string;
};

export type RetainedCleanupPlan = {
  version: 1;
  generation: number;
  binding: string;
  sessionId: string;
  resources: RetainedCleanupResource[];
  dataLoss: string[];
  retained: string[];
  notReclaimed: string[];
};

export type RetainedCleanupInspection =
  | { state: 'eligible'; podId: string; plan: RetainedCleanupPlan }
  | { state: 'blocked'; podId: string; blockers: RetainedCleanupBlocker[] }
  | { state: 'requested'; podId: string; requestId: string };

export type RetainedCleanupReceipt = {
  podId: string;
  request: RetainedCleanupRequest;
  actor: { type: 'human'; userId: string };
  plan: RetainedCleanupPlan;
  createdAt: string;
  updatedAt: string;
  state: 'pending' | 'partial' | 'deleted';
  resources: (RetainedCleanupResource & {
    state: 'pending' | 'removal_unconfirmed' | 'confirmed_absent';
  })[];
  blockers: RetainedCleanupBlocker[];
};

export type RetainedCleanupSubmission =
  | RetainedCleanupReceipt
  | { state: 'blocked'; podId: string; blockers: RetainedCleanupBlocker[] };
