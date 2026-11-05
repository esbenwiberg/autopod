import type { OperatorActor } from './podsitter.js';

/** Finalization never authorizes source/resource deletion or another worker run. */
export type RetainedFinalizationMode = 'stop-retain' | 'complete-merged';

export interface RetainedFinalizationRequest {
  requestKey: string;
  expectedGeneration: number;
  expectedBinding: string;
  mode: RetainedFinalizationMode;
  reason: string;
}

export interface RetainedFinalizationReceipt {
  podId: string;
  request: RetainedFinalizationRequest;
  actor: OperatorActor;
  state: 'pending' | 'finalized';
  createdAt: string;
  finalizedAt: string | null;
  message: string;
  resourcesRetained: true;
}

export interface RetainedFinalizationView {
  podId: string;
  generation: number;
  status: string;
  binding: string;
  custody: Array<{ kind: 'continuation' | 'approval-rewrite'; id: string }>;
  canStop: boolean;
  canCompleteMerged: boolean;
  blockers: string[];
  operation: RetainedFinalizationReceipt | null;
}
