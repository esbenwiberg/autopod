import type { AgentEvent, Pod, SystemEvent } from '@autopod/shared';
import { create } from 'zustand';
import { AuthRequiredError, apiFetch } from '../lib/api.js';

export const ACTIVITY_LIMIT = 20;

interface PodsState {
  pods: Pod[];
  loading: boolean;
  error: string | null;
  connected: boolean;
  /** Per-pod ring buffer of recent agent activity. Populated only while a
   *  pod-detail screen is mounted (see `trackActivity` / `untrackActivity`). */
  activity: Record<string, AgentEvent[]>;
  refresh: () => Promise<void>;
  applyEvent: (event: SystemEvent) => void;
  setConnected: (connected: boolean) => void;
  trackActivity: (podId: string, seed: AgentEvent[]) => void;
  untrackActivity: (podId: string) => void;
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

function appendCapped(buf: AgentEvent[] | undefined, event: AgentEvent): AgentEvent[] {
  const base = buf ?? [];
  const next = [...base, event];
  return next.length > ACTIVITY_LIMIT ? next.slice(next.length - ACTIVITY_LIMIT) : next;
}

export const usePodsStore = create<PodsState>((set, get) => ({
  pods: [],
  loading: false,
  error: null,
  connected: false,
  activity: {},

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

  trackActivity: (podId, seed) =>
    set((state) => ({
      activity: { ...state.activity, [podId]: seed.slice(-ACTIVITY_LIMIT) },
    })),

  untrackActivity: (podId) =>
    set((state) => {
      if (!(podId in state.activity)) return state;
      const { [podId]: _omit, ...rest } = state.activity;
      return { activity: rest };
    }),

  applyEvent: (event) => {
    switch (event.type) {
      case 'pod.created': {
        // Server sends `PodSummary`; refetch the canonical Pod so detail-view
        // fields (pendingEscalation, lastValidationResult, …) are present.
        // Failures are non-fatal — the next /pods refresh will pick the pod up.
        apiFetch<Pod>(`/pods/${event.pod.id}`)
          .then((pod) => {
            const current = get().pods;
            const exists = current.some((p) => p.id === pod.id);
            set({ pods: exists ? patchPod(current, pod.id, pod) : [pod, ...current] });
          })
          .catch(() => undefined);
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
      case 'pod.agent_activity': {
        // Append only when the detail screen is mounted for this pod — otherwise
        // the global subscription would grow an unbounded map across the fleet.
        const buf = get().activity[event.podId];
        if (!buf) return;
        set({ activity: { ...get().activity, [event.podId]: appendCapped(buf, event.event) } });
        return;
      }
      default:
        // Many event types don't affect the views we currently render.
        return;
    }
  },
}));
