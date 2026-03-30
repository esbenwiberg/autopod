import type { Session } from '@autopod/shared';
import type React from 'react';
import { StatusBadge } from './StatusBadge.js';

interface SessionListProps {
  sessions: Session[];
  loading: boolean;
  error: string | null;
  onSelect: (session: Session) => void;
  onRefresh: () => void;
  onSettingsClick: () => void;
}

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export function SessionList({
  sessions,
  loading,
  error,
  onSelect,
  onRefresh,
  onSettingsClick,
}: SessionListProps): React.ReactElement {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* Header */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '12px 16px',
          borderBottom: '1px solid var(--border)',
          background: 'var(--surface)',
          flexShrink: 0,
        }}
      >
        <span style={{ fontWeight: 700, fontSize: 16 }}>Autopod</span>
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            type="button"
            className="btn-ghost"
            style={{ padding: '4px 10px' }}
            onClick={onRefresh}
          >
            ↺
          </button>
          <button
            type="button"
            className="btn-ghost"
            style={{ padding: '4px 10px' }}
            onClick={onSettingsClick}
          >
            ⚙
          </button>
        </div>
      </div>

      {/* Body */}
      <div style={{ flex: 1, overflowY: 'auto' }}>
        {loading && sessions.length === 0 && (
          <p style={{ padding: 20, color: 'var(--text-muted)', textAlign: 'center' }}>Loading…</p>
        )}
        {error && (
          <p style={{ padding: 20, color: 'var(--error)', textAlign: 'center', fontSize: 13 }}>
            {error}
          </p>
        )}
        {!loading && sessions.length === 0 && !error && (
          <p style={{ padding: 20, color: 'var(--text-muted)', textAlign: 'center' }}>
            No sessions yet.
          </p>
        )}
        {sessions.map((s) => (
          <button
            type="button"
            key={s.id}
            onClick={() => onSelect(s)}
            style={{
              display: 'block',
              width: '100%',
              padding: '12px 16px',
              textAlign: 'left',
              background: 'transparent',
              borderRadius: 0,
              borderBottom: '1px solid var(--border)',
              color: 'var(--text)',
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
              <span style={{ fontWeight: 600, fontSize: 13 }}>
                {s.task.length > 52 ? `${s.task.slice(0, 52)}…` : s.task}
              </span>
              <StatusBadge status={s.status} />
            </div>
            <div style={{ display: 'flex', gap: 12, color: 'var(--text-muted)', fontSize: 11 }}>
              <span>{s.profileName}</span>
              <span>{s.id.slice(0, 8)}</span>
              <span>{relativeTime(s.createdAt)}</span>
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}
