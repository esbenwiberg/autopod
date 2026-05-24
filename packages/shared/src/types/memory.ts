export type MemoryScope = 'global' | 'profile' | 'pod';

export type MemoryKind =
  | 'convention'
  | 'gotcha'
  | 'workflow'
  | 'dependency'
  | 'review_feedback'
  | 'other';

export interface MemorySourceEvidence {
  podId: string;
  signal: string;
  excerpt: string;
  severity?: 'low' | 'medium' | 'high';
  createdAt: string;
}

export interface MemoryEntry {
  id: string;
  scope: MemoryScope;
  /** null = global, profileName = profile, podId = pod */
  scopeId: string | null;
  /** Path-like key, e.g. "/conventions/commits.md" */
  path: string;
  content: string;
  contentSha256: string;
  /** Optional one-sentence explanation of why the memory matters. Null for legacy entries. */
  rationale: string | null;
  kind: MemoryKind | null;
  tags: string[];
  appliesWhen: string | null;
  avoidWhen: string | null;
  /** Confidence score in [0, 1]. Null for legacy entries. */
  confidence: number | null;
  sourceEvidence: MemorySourceEvidence[];
  impactSummary: string | null;
  version: number;
  approved: boolean;
  createdByPodId: string | null;
  createdAt: string;
  updatedAt: string;
}

export type MemoryCandidateStatus = 'pending' | 'approved' | 'rejected';
export type MemoryCandidateAction = 'create' | 'update';

export interface MemoryCandidate {
  id: string;
  action: MemoryCandidateAction;
  /** Set when action === 'update'. */
  targetMemoryId: string | null;
  scope: 'profile';
  scopeId: string;
  path: string;
  content: string;
  rationale: string;
  kind: MemoryKind;
  tags: string[];
  appliesWhen: string | null;
  avoidWhen: string | null;
  /** Confidence score in [0, 1]. */
  confidence: number;
  sourceEvidence: MemorySourceEvidence[];
  impactSummary: string;
  status: MemoryCandidateStatus;
  createdByPodId: string;
  fallbackReason: string | null;
  createdAt: string;
  updatedAt: string;
}

export type MemoryUsageKind =
  | 'selected'
  | 'injected'
  | 'read'
  | 'searched'
  | 'plan_reported'
  | 'summary_reported'
  | 'not_reported';

export type MemoryUsageOutcome = 'intended' | 'applied' | 'not_applicable' | 'harmful_stale';

export interface MemoryUsageEvent {
  id: string;
  memoryId: string;
  podId: string;
  kind: MemoryUsageKind;
  outcome: MemoryUsageOutcome | null;
  reason: string | null;
  relevanceReason: string | null;
  createdAt: string;
}
