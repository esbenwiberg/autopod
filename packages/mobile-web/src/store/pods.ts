import type { Pod } from '@autopod/shared';
import { create } from 'zustand';
import { AuthRequiredError, apiFetch } from '../lib/api.js';

interface PodsState {
  pods: Pod[];
  loading: boolean;
  error: string | null;
  loadedAt: number | null;
  refresh: () => Promise<void>;
}

export const usePodsStore = create<PodsState>((set) => ({
  pods: [],
  loading: false,
  error: null,
  loadedAt: null,
  refresh: async () => {
    set({ loading: true, error: null });
    try {
      const pods = await apiFetch<Pod[]>('/pods');
      set({ pods, loading: false, loadedAt: Date.now() });
    } catch (err) {
      if (err instanceof AuthRequiredError) {
        // apiFetch already redirected; clear local state.
        set({ pods: [], loading: false, error: null });
        return;
      }
      set({ loading: false, error: (err as Error).message });
    }
  },
}));
