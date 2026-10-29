import type { OperatorActor } from './podsitter.js';

/** An explicit source change and checks request; NEVER approval, publication, merge or release authority. */
export interface SourceAdoptionRequest {
  id: string;
  expectedGeneration: number;
  oldHeadSha: string;
  targetHeadSha: string;
  dependencySetupCommand: string;
  reason: string;
}
export type SourceAdoptionStage =
  | 'claimed'
  | 'preserved'
  | 'applying'
  | 'adopted'
  | 'checking'
  | 'checked';
export interface SourceAdoptionState {
  id: string;
  podId: string;
  generation: number;
  oldHeadSha: string;
  targetHeadSha: string;
  stage: SourceAdoptionStage;
  validation: 'pending' | 'pass' | 'fail';
  error: string | null;
  actor: OperatorActor;
  reports: 'not-released';
  delivery: 'not-authorized';
}
export interface SourceAdoptionList {
  operations: SourceAdoptionState[];
}
