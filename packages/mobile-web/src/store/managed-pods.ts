import { create } from 'zustand';
import { AuthRequiredError, apiFetch } from '../lib/api.js';

export interface ManagedPodFailure {
  phase: string;
  reason: string;
  httpStatus: number | null;
}

export interface ManagedArtifactSummary {
  artifactId: string;
  status: string;
  fileCount: number;
  totalBytes: number;
  committedAt: number | null;
}

export interface ManagedPodSummary {
  podId: string;
  dispatcherAttemptId: string;
  state: string;
  providerAccountId: string;
  model: string;
  runtime: string;
  executionTarget: string;
  reasoning: string;
  profileId: string;
  profileVersion: number;
  providerRequests: number;
  consumedTokens: number;
  tokenUsageKnown: boolean;
  failure: ManagedPodFailure | null;
  limitations: string[];
  artifacts: ManagedArtifactSummary[];
  revoked: boolean;
  stopRequested: boolean;
  observedExit: boolean;
  cleanup: string;
  exitCode: number | null;
  createdAt: number;
  lastEventAt: number;
}

interface ManagedPodPage {
  schemaVersion: 1;
  pods: ManagedPodSummary[];
  nextCursor: string | null;
}

interface ManagedPodsState {
  pods: ManagedPodSummary[];
  loading: boolean;
  loaded: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

async function fetchAllManagedPods(): Promise<ManagedPodSummary[]> {
  const pods: ManagedPodSummary[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | null = null;
  do {
    const query = new URLSearchParams({ limit: '100' });
    if (cursor) query.set('cursor', cursor);
    const page = await apiFetch<ManagedPodPage>(`/managed/pods?${query.toString()}`);
    pods.push(...page.pods);
    cursor = page.nextCursor;
    if (cursor && seenCursors.has(cursor))
      throw new Error('Managed pod pagination repeated a cursor');
    if (cursor) seenCursors.add(cursor);
  } while (cursor);
  return pods;
}

export const useManagedPodsStore = create<ManagedPodsState>((set, get) => ({
  pods: [],
  loading: false,
  loaded: false,
  error: null,

  refresh: async () => {
    if (get().loading) return;
    set({ loading: true, error: null });
    try {
      const pods = await fetchAllManagedPods();
      set({ pods, loading: false, loaded: true });
    } catch (error) {
      if (error instanceof AuthRequiredError) {
        set({ pods: [], loading: false, loaded: false, error: null });
        return;
      }
      // Preserve the last useful inventory across transient daemon failures.
      set({ loading: false, error: (error as Error).message });
    }
  },
}));
