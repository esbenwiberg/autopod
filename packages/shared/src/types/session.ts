// Re-export shim — all types have moved to pod.ts.
// This file exists only to ease the rename transition and will be removed.
export type {
  CreatePodRequest as CreateSessionRequest,
  Pod as Session,
  PodStatus as SessionStatus,
  PodSummary as SessionSummary,
  ReferenceRepo,
} from './pod.js';
