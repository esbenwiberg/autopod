import type { OperatorActor } from '@autopod/shared';

/** Internal protocol only: not an operator API or permission to publish/merge. */
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
