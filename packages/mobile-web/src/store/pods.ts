import type { Pod, SystemEvent } from '@autopod/shared';
import { create } from 'zustand';
import { AuthRequiredError, apiFetch } from '../lib/api.js';

interface PodsState {
  pods: Pod[];
  loading: boolean;
  error: string | null;
  connected: boolean;
  refresh: () => Promise<void>;
  applyEvent: (event: SystemEvent) => void;
  setConnected: (connected: boolean) => void;
}

function patchPod(pods: Pod[], podId: string, patch: Partial<Pod>): Pod[] {
  let changed = false;
  const next = pods.map((p) => {
    if (p.id !== podId) return p;
    changed = true;
    return { ...p, ...patch };
  });
  return changed ? next : pods;
}

export const usePodsStore = create<PodsState>((set, get) => ({
  pods: [],
  loading: false,
  error: null,
  connected: false,

  refresh: async () => {
    set({ loading: true, error: null });
    try {
      const pods = await apiFetch<Pod[]>('/pods');
      set({ pods, loading: false });
    } catch (err) {
      if (err instanceof AuthRequiredError) {
        set({ pods: [], loading: false, error: null });
        return;
      }
      set({ loading: false, error: (err as Error).message });
    }
  },

  setConnected: (connected) => set({ connected }),

  applyEvent: (event) => {
    switch (event.type) {
      case 'pod.created': {
        // Server sends `PodSummary` not full `Pod`. Fetch the canonical row to
        // get fields like `pendingEscalation` and `lastValidationResult`.
        void apiFetch<Pod>(`/pods/${event.pod.id}`).then((pod) => {
          const exists = get().pods.some((p) => p.id === pod.id);
          set({ pods: exists ? patchPod(get().pods, pod.id, pod) : [pod, ...get().pods] });
        });
        return;
      }
      case 'pod.status_changed':
        set({ pods: patchPod(get().pods, event.podId, { status: event.newStatus }) });
        return;
      case 'pod.completed':
        set({
          pods: patchPod(get().pods, event.podId, {
            status: event.finalStatus,
            completedAt: event.timestamp,
          }),
        });
        return;
      case 'pod.escalation_created':
        set({
          pods: patchPod(get().pods, event.podId, {
            status: 'awaiting_input',
            pendingEscalation: event.escalation,
          }),
        });
        return;
      case 'pod.escalation_resolved':
        set({
          pods: patchPod(get().pods, event.podId, {
            pendingEscalation: null,
          }),
        });
        return;
      case 'pod.validation_completed':
        set({
          pods: patchPod(get().pods, event.podId, {
            lastValidationResult: event.result,
          }),
        });
        return;
      default:
        // Many event types (agent_activity, validation_phase_*, scheduled_job_*, …)
        // don't affect the list view. Ignored; step 4 picks up agent_activity for
        // the per-pod activity tail.
        return;
    }
  },
}));
