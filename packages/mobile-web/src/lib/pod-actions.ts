import type { Pod, PodStatus } from '@autopod/shared';
import { apiFetch } from './api.js';

/**
 * Single source of truth for which actions are reachable per pod status, and
 * what optimistic patch each one applies. Components derive from this table.
 *
 * Step 5 ships pause / resume / kill / nudge. Step 6 adds answer/approve/reject;
 * step 7 adds force-complete / extend-attempts / update-from-base / spawn-fix.
 */
export type ActionKind = 'pause' | 'resume' | 'kill' | 'nudge';

export interface ActionDef {
  kind: ActionKind;
  label: string;
  tone: 'neutral' | 'warn' | 'danger';
  /** Optimistic patch applied pre-flight and reverted on error. */
  optimistic: Partial<Pod> | null;
  /** When true, the UI opens a text-input modal before calling the action. */
  promptsForText: boolean;
}

const PAUSE: ActionDef = {
  kind: 'pause',
  label: 'Pause',
  tone: 'neutral',
  optimistic: { status: 'paused' },
  promptsForText: false,
};
const RESUME: ActionDef = {
  kind: 'resume',
  label: 'Resume',
  tone: 'neutral',
  optimistic: { status: 'running' },
  promptsForText: false,
};
const KILL: ActionDef = {
  kind: 'kill',
  label: 'Kill',
  tone: 'danger',
  optimistic: { status: 'killing' },
  promptsForText: false,
};
const NUDGE: ActionDef = {
  kind: 'nudge',
  label: 'Nudge',
  tone: 'neutral',
  optimistic: null,
  promptsForText: true,
};

const ACTIONS_BY_STATUS: Partial<Record<PodStatus, ActionDef[]>> = {
  running: [PAUSE, NUDGE, KILL],
  paused: [RESUME, NUDGE, KILL],
  awaiting_input: [KILL],
  queued: [KILL],
  provisioning: [KILL],
  validating: [KILL],
};

export function availableActions(status: PodStatus): ActionDef[] {
  return ACTIONS_BY_STATUS[status] ?? [];
}

/**
 * Calls the right daemon endpoint for the given action.
 * No optimistic patch handling here — the caller applies it.
 */
export async function runAction(podId: string, kind: ActionKind, message?: string): Promise<void> {
  switch (kind) {
    case 'pause':
      await apiFetch(`/pods/${podId}/pause`, { method: 'POST' });
      return;
    case 'kill':
      await apiFetch(`/pods/${podId}/kill`, { method: 'POST' });
      return;
    case 'resume':
      // No dedicated unpause endpoint — a nudge releases the paused pod.
      await apiFetch(`/pods/${podId}/nudge`, {
        method: 'POST',
        body: JSON.stringify({ message: message ?? 'continue' }),
      });
      return;
    case 'nudge':
      await apiFetch(`/pods/${podId}/nudge`, {
        method: 'POST',
        body: JSON.stringify({ message: message ?? '' }),
      });
      return;
  }
}
