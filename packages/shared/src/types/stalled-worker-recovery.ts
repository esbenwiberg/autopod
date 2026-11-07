import type { OperatorActor } from './podsitter.js';

/** Explicit termination and preservation only; never a retry or delivery request. */
export interface StalledWorkerRecoveryRequest {
  requestKey: string;
  expectedGeneration: number;
  expectedBinding: string;
  reason: string;
}
export interface StalledWorkerRecoveryReceipt {
  podId: string;
  request: StalledWorkerRecoveryRequest;
  actor: OperatorActor;
  state: 'pending' | 'settled';
  createdAt: string;
  settledAt: string | null;
  message: string;
  resourcesRetained: true;
}
export interface StalledWorkerRecoveryView {
  schemaVersion: 1;
  podId: string;
  generation: number;
  status: string;
  binding: string;
  canStop: boolean;
  blockers: string[];
  failureReason: string | null;
  guidanceBlocker: string | null;
  operation: StalledWorkerRecoveryReceipt | null;
}
