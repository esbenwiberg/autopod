/** Review-only publication. None of these receipts authorize ordinary delivery. */
export interface SavedWorkSource {
  id: string;
  kind: 'sandbox-checkpoint' | 'local-commit';
  commit: string;
  tree: string;
  parent: string | null;
  parentTree: string | null;
  ref: string;
  capturedAt: string | null;
  freshness: 'latest-saved' | 'older-saved' | 'host-commit-only';
  exclusions: string;
}
export interface SavedWorkDraftPreview {
  podId: string;
  generation: number;
  binding: string;
  repository: string;
  baseBranch: string;
  sources: SavedWorkSource[];
  checks: string;
  blockers: string[];
  operation: SavedWorkDraftOperation | null;
}
export interface SavedWorkDraftPrepare {
  requestId: string;
  expectedBinding: string;
  sourceId: string;
}
export interface SavedWorkDraftConfirm {
  requestId: string;
  expectedBinding: string;
  draftOnly: true;
}
export interface SavedWorkDraftCancel {
  requestId: string;
  expectedBinding: string;
}
/** Durable revocation of one exact preparation request, including delayed arrivals. */
export interface SavedWorkDraftPreparationCancellation extends SavedWorkDraftPrepare {
  podId: string;
  actorId: string;
  state: 'cancelled-before-publication';
}
export interface SavedWorkDraftOperation {
  id: string;
  requestId: string;
  podId: string;
  actorId: string;
  generation: number;
  taskId: string;
  originalWorktreePath: string;
  originalContainerId: string | null;
  sourceLocations: string[];
  previewBinding: string;
  confirmationBinding: string;
  repository: string;
  baseBranch: string;
  branch: string;
  source: SavedWorkSource;
  checks: string;
  body: string;
  createdAt: string;
  expiresAt: string;
  state:
    | 'preparing'
    | 'prepared'
    | 'push-uncertain'
    | 'pushed'
    | 'create-uncertain'
    | 'published'
    | 'cancelled';
  message?: string;
  receipt: { url: string; draft: true; head: string; baseBranch: string; branch: string } | null;
}
