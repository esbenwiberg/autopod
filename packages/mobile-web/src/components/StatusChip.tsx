import type { PodStatus } from '@autopod/shared';

const TONE: Record<PodStatus, 'neutral' | 'progress' | 'ok' | 'warn' | 'danger'> = {
  queued: 'neutral',
  provisioning: 'progress',
  running: 'progress',
  validating: 'progress',
  validated: 'ok',
  approved: 'ok',
  merging: 'progress',
  merge_pending: 'progress',
  complete: 'ok',
  paused: 'warn',
  handoff: 'warn',
  awaiting_input: 'warn',
  review_required: 'warn',
  failed: 'danger',
  killing: 'danger',
  killed: 'neutral',
};

interface Props {
  status: PodStatus;
}

export function StatusChip({ status }: Props): JSX.Element {
  return <span className={`chip chip-${TONE[status]}`}>{status.replace(/_/g, ' ')}</span>;
}
