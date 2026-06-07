export type ReadinessStatus = 'ready' | 'needs_review' | 'risky' | 'waived';

export type ReadinessAreaStatus =
  | ReadinessStatus
  | 'not_applicable'
  | 'not_available';

export type ReadinessArea =
  | 'validation'
  | 'security'
  | 'actions'
  | 'network'
  | 'scope'
  | 'quality'
  | 'advisory_qa'
  | 'pr';

export type ReadinessFindingSeverity = 'info' | 'warning' | 'error';

export type ReadinessSourceRefKind =
  | 'validation'
  | 'work'
  | 'logs'
  | 'diff'
  | 'pr'
  | 'evidence'
  | 'quality'
  | 'event';

export interface ReadinessSourceRef {
  kind: ReadinessSourceRefKind;
  label: string;
  id?: string;
  href?: string;
}

export interface ReadinessAreaReview {
  area: ReadinessArea;
  status: ReadinessAreaStatus;
  title: string;
  summary: string;
  sourceRefs: ReadinessSourceRef[];
}

export interface ReadinessFinding {
  id: string;
  area: ReadinessArea;
  severity: ReadinessFindingSeverity;
  title: string;
  detail: string;
  sourceRefs: ReadinessSourceRef[];
}

export interface ReadinessApproval {
  approvedAt: string;
  approvedBy?: string;
  statusAtApproval: ReadinessStatus;
  scope: 'pod' | 'series';
  seriesId?: string;
  reason?: string;
}

export interface ReadinessReview {
  status: ReadinessStatus;
  summary: string;
  computedAt: string;
  scope: 'pod';
  areas: ReadinessAreaReview[];
  findings: ReadinessFinding[];
  approval?: ReadinessApproval | null;
}
