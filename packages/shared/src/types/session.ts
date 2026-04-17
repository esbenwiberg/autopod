// Re-export shim — all types have moved to pod.ts.
// This file exists only to ease the rename transition and will be removed.
export type {
  ReferenceRepo,
  PodStatus as SessionStatus,
  Pod as Session,
  CreatePodRequest as CreateSessionRequest,
  PodSummary as SessionSummary,
} from './pod.js';
