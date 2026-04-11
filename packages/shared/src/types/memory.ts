export type MemoryScope = 'global' | 'profile' | 'session';

export interface MemoryEntry {
  id: string;
  scope: MemoryScope;
  /** null = global, profileName = profile, sessionId = session */
  scopeId: string | null;
  /** Path-like key, e.g. "/conventions/commits.md" */
  path: string;
  content: string;
  contentSha256: string;
  version: number;
  approved: boolean;
  createdBySessionId: string | null;
  createdAt: string;
  updatedAt: string;
}
