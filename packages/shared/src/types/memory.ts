export type MemoryScope = 'global' | 'profile' | 'pod';

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
  version: number;
  approved: boolean;
  createdByPodId: string | null;
  createdAt: string;
  updatedAt: string;
}
