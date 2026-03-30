import type { SessionStatus } from '@autopod/shared';
import type React from 'react';

const COLOR: Record<string, string> = {
  queued: '#94a3b8',
  provisioning: '#6366f1',
  running: '#3b82f6',
  awaiting_input: '#f59e0b',
  validating: '#8b5cf6',
  validated: '#22c55e',
  failed: '#ef4444',
  approved: '#10b981',
  merging: '#8b5cf6',
  complete: '#64748b',
  paused: '#f59e0b',
  killing: '#ef4444',
  killed: '#64748b',
};

export function StatusBadge({ status }: { status: SessionStatus }): React.ReactElement {
  const color = COLOR[status] ?? '#94a3b8';
  return (
    <span
      className="badge"
      style={{ background: `${color}22`, color, border: `1px solid ${color}55` }}
    >
      {status.replace('_', ' ')}
    </span>
  );
}
