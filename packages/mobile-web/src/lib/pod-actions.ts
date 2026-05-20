import type { Pod, PodStatus } from '@autopod/shared';
import { apiFetch } from './api.js';

/**
 * Single source of truth for which actions are reachable per pod status, and
 * what optimistic patch each one applies. Components derive from this table.
 *
 * Step 5 ships pause / resume / kill / nudge. Step 6 adds answer/approve/reject;
 * step 7 adds force-complete / extend-attempts / update-from-base / spawn-fix.
 */
export type ActionKind =
  | 'pause'
  | 'resume'
  | 'kill'
  | 'nudge'
  | 'approve'
  | 'reject'
  | 'force_complete'
  | 'extend_attempts'
  | 'extend_pr_attempts'
  | 'update_from_base'
  | 'spawn_fix';

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
const APPROVE: ActionDef = {
  kind: 'approve',
  label: 'Approve',
  tone: 'neutral',
  optimistic: { status: 'approved' },
  promptsForText: false,
};
const REJECT: ActionDef = {
  kind: 'reject',
  label: 'Reject',
  tone: 'warn',
  // Server resets attempt counter; transition is back to `running` for rework.
  optimistic: { status: 'running' },
  promptsForText: true,
};
const EXTEND_ATTEMPTS: ActionDef = {
  kind: 'extend_attempts',
  label: 'Extend (+3)',
  tone: 'neutral',
  optimistic: null,
  promptsForText: false,
};
const EXTEND_PR_ATTEMPTS: ActionDef = {
  kind: 'extend_pr_attempts',
  label: 'Extend PR fixes (+3)',
  tone: 'neutral',
  optimistic: null,
  promptsForText: false,
};
const UPDATE_FROM_BASE: ActionDef = {
  kind: 'update_from_base',
  label: 'Rebase + revalidate',
  tone: 'neutral',
  optimistic: null,
  promptsForText: false,
};
const SPAWN_FIX: ActionDef = {
  kind: 'spawn_fix',
  label: 'Spawn fix',
  tone: 'neutral',
  optimistic: null,
  promptsForText: true,
};
const FORCE_COMPLETE: ActionDef = {
  kind: 'force_complete',
  label: 'Force complete',
  tone: 'warn',
  optimistic: { status: 'complete' },
  promptsForText: true,
};
const RESUME_FAILED: ActionDef = {
  kind: 'resume',
  label: 'Resume',
  tone: 'neutral',
  optimistic: null, // Server picks the recovery path; status follows.
  promptsForText: false,
};

const ACTIONS_BY_STATUS: Partial<Record<PodStatus, ActionDef[]>> = {
  running: [PAUSE, NUDGE, KILL],
  paused: [RESUME, NUDGE, KILL],
  // Answer surfaces as a dedicated card (EscalationCard) above the bar.
  awaiting_input: [KILL],
  queued: [KILL],
  provisioning: [KILL],
  validating: [KILL],
  validated: [APPROVE, REJECT, KILL],
  review_required: [APPROVE, REJECT, EXTEND_ATTEMPTS, SPAWN_FIX, KILL],
  failed: [RESUME_FAILED, UPDATE_FROM_BASE, EXTEND_PR_ATTEMPTS, SPAWN_FIX, FORCE_COMPLETE, KILL],
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
    case 'approve':
      await apiFetch(`/pods/${podId}/approve`, { method: 'POST', body: JSON.stringify({}) });
      return;
    case 'reject':
      await apiFetch(`/pods/${podId}/reject`, {
        method: 'POST',
        body: JSON.stringify(message ? { feedback: message } : {}),
      });
      return;
    case 'extend_attempts':
      await apiFetch(`/pods/${podId}/extend-attempts`, {
        method: 'POST',
        body: JSON.stringify({ additionalAttempts: 3 }),
      });
      return;
    case 'extend_pr_attempts':
      await apiFetch(`/pods/${podId}/extend-pr-attempts`, {
        method: 'POST',
        body: JSON.stringify({ additionalAttempts: 3 }),
      });
      return;
    case 'update_from_base':
      await apiFetch(`/pods/${podId}/update-from-base`, { method: 'POST' });
      return;
    case 'spawn_fix':
      await apiFetch(`/pods/${podId}/spawn-fix`, {
        method: 'POST',
        body: JSON.stringify({ message: message ?? '' }),
      });
      return;
    case 'force_complete':
      await apiFetch(`/pods/${podId}/force-complete`, {
        method: 'POST',
        body: JSON.stringify(message ? { reason: message } : {}),
      });
      return;
  }
}

/** Toggle the `skipValidation` flag on a running pod. Returns the new value. */
export async function toggleSkipValidation(podId: string, skip: boolean): Promise<void> {
  await apiFetch(`/pods/${podId}/skip-validation`, {
    method: 'POST',
    body: JSON.stringify({ skip }),
  });
}
