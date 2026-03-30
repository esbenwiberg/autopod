import type { Session } from '@autopod/shared';
import type React from 'react';
import { useState } from 'react';
import type { AutopodWebClient } from '../api/client.js';
import { StatusBadge } from './StatusBadge.js';
import { Terminal } from './Terminal.js';

interface SessionDetailProps {
  session: Session;
  client: AutopodWebClient;
  onBack: () => void;
  onUpdated: () => void;
}

export function SessionDetail({
  session,
  client,
  onBack,
  onUpdated,
}: SessionDetailProps): React.ReactElement {
  const [busy, setBusy] = useState(false);
  const [msgInput, setMsgInput] = useState('');
  const [terminalWsUrl, setTerminalWsUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const showTerminal = terminalWsUrl !== null;

  const act = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      onUpdated();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const isWorkspace = session.outputMode === 'workspace';
  const isRunning = session.status === 'running';
  const isValidated = session.status === 'validated';
  const isAwaitingInput = session.status === 'awaiting_input';
  const canKill = !['complete', 'killed', 'killing'].includes(session.status);
  const canPause = session.status === 'running';

  if (showTerminal && isWorkspace && isRunning) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            padding: '10px 16px',
            borderBottom: '1px solid var(--border)',
            background: 'var(--surface)',
            flexShrink: 0,
          }}
        >
          <button
            type="button"
            className="btn-ghost"
            style={{ padding: '4px 10px' }}
            onClick={() => setTerminalWsUrl(null)}
          >
            ← Back
          </button>
          <span style={{ fontSize: 13, color: 'var(--text-muted)' }}>
            Terminal — {session.id.slice(0, 8)}
          </span>
        </div>
        <div style={{ flex: 1, overflow: 'hidden' }}>
          <Terminal wsUrl={terminalWsUrl} />
        </div>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* Header */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          padding: '10px 16px',
          borderBottom: '1px solid var(--border)',
          background: 'var(--surface)',
          flexShrink: 0,
        }}
      >
        <button
          type="button"
          className="btn-ghost"
          style={{ padding: '4px 10px' }}
          onClick={onBack}
        >
          ←
        </button>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              fontWeight: 600,
              fontSize: 14,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {session.task}
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 2 }}>
            <StatusBadge status={session.status} />
            <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>{session.profileName}</span>
          </div>
        </div>
      </div>

      {/* Body */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '16px' }}>
        {error && (
          <div
            style={{
              background: '#ef444422',
              border: '1px solid #ef4444',
              borderRadius: 6,
              padding: '10px 14px',
              marginBottom: 14,
              fontSize: 13,
              color: 'var(--error)',
            }}
          >
            {error}
          </div>
        )}

        {/* Plan */}
        {session.plan && (
          <section style={{ marginBottom: 20 }}>
            <h3
              style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 8, fontWeight: 600 }}
            >
              PLAN
            </h3>
            <p style={{ marginBottom: 8 }}>{session.plan.summary}</p>
            <ol style={{ paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 4 }}>
              {session.plan.steps.map((step) => (
                <li key={step} style={{ fontSize: 13, color: 'var(--text-muted)' }}>
                  {step}
                </li>
              ))}
            </ol>
          </section>
        )}

        {/* Progress */}
        {session.progress && (
          <section style={{ marginBottom: 20 }}>
            <h3
              style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 6, fontWeight: 600 }}
            >
              PROGRESS — {session.progress.phase}
            </h3>
            <p style={{ fontSize: 13 }}>{session.progress.description}</p>
            {session.progress.totalPhases > 0 && (
              <div
                style={{
                  marginTop: 8,
                  height: 4,
                  background: 'var(--surface2)',
                  borderRadius: 2,
                  overflow: 'hidden',
                }}
              >
                <div
                  style={{
                    height: '100%',
                    background: 'var(--accent)',
                    width: `${(session.progress.currentPhase / session.progress.totalPhases) * 100}%`,
                    transition: 'width 0.4s ease',
                  }}
                />
              </div>
            )}
          </section>
        )}

        {/* Escalation (awaiting_input) */}
        {isAwaitingInput && session.pendingEscalation && (
          <section style={{ marginBottom: 20 }}>
            <h3
              style={{
                fontSize: 13,
                color: 'var(--warning)',
                marginBottom: 8,
                fontWeight: 600,
              }}
            >
              NEEDS YOUR INPUT
            </h3>
            <div
              style={{
                background: '#f59e0b18',
                border: '1px solid #f59e0b55',
                borderRadius: 6,
                padding: '10px 14px',
                marginBottom: 10,
                fontSize: 13,
              }}
            >
              {'question' in session.pendingEscalation.payload
                ? session.pendingEscalation.payload.question
                : 'description' in session.pendingEscalation.payload
                  ? session.pendingEscalation.payload.description
                  : 'Agent needs input'}
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <input
                value={msgInput}
                onChange={(e) => setMsgInput(e.target.value)}
                placeholder="Your answer…"
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && msgInput.trim()) {
                    act(() => client.sendMessage(session.id, msgInput.trim()));
                    setMsgInput('');
                  }
                }}
                style={{ flex: 1 }}
              />
              <button
                type="button"
                className="btn-primary"
                disabled={busy || !msgInput.trim()}
                onClick={() => {
                  if (msgInput.trim()) {
                    act(() => client.sendMessage(session.id, msgInput.trim()));
                    setMsgInput('');
                  }
                }}
              >
                Send
              </button>
            </div>
          </section>
        )}

        {/* Validation result */}
        {session.lastValidationResult && (
          <section style={{ marginBottom: 20 }}>
            <h3
              style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 8, fontWeight: 600 }}
            >
              VALIDATION
            </h3>
            <p
              style={{
                fontSize: 13,
                color:
                  session.lastValidationResult.overall === 'pass'
                    ? 'var(--success)'
                    : 'var(--error)',
                marginBottom: 6,
              }}
            >
              {session.lastValidationResult.overall === 'pass' ? '✓ Passed' : '✗ Failed'}
            </p>
            {session.lastValidationResult.taskReview?.reasoning && (
              <p style={{ fontSize: 13, color: 'var(--text-muted)' }}>
                {session.lastValidationResult.taskReview.reasoning}
              </p>
            )}
            {session.prUrl && (
              <a
                href={session.prUrl}
                target="_blank"
                rel="noopener noreferrer"
                style={{ fontSize: 13 }}
              >
                View PR →
              </a>
            )}
          </section>
        )}

        {/* Meta */}
        <section style={{ marginBottom: 20 }}>
          <table
            style={{
              fontSize: 12,
              color: 'var(--text-muted)',
              borderCollapse: 'collapse',
              width: '100%',
            }}
          >
            <tbody>
              {[
                ['ID', session.id],
                ['Branch', session.branch],
                ['Runtime', session.runtime],
                ['Files changed', String(session.filesChanged)],
                ['Lines added', String(session.linesAdded)],
                ['Lines removed', String(session.linesRemoved)],
              ].map(([label, value]) => (
                <tr key={label}>
                  <td style={{ padding: '3px 0', paddingRight: 16, whiteSpace: 'nowrap' }}>
                    {label}
                  </td>
                  <td style={{ padding: '3px 0', color: 'var(--text)', wordBreak: 'break-all' }}>
                    {value}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      </div>

      {/* Action bar */}
      <div
        style={{
          padding: '10px 16px',
          borderTop: '1px solid var(--border)',
          background: 'var(--surface)',
          display: 'flex',
          gap: 8,
          flexWrap: 'wrap',
          flexShrink: 0,
        }}
      >
        {isWorkspace && isRunning && (
          <button
            type="button"
            className="btn-ghost"
            onClick={() => {
              client
                .terminalWsUrl(session.id)
                .then(setTerminalWsUrl)
                .catch(() => {});
            }}
          >
            Terminal
          </button>
        )}
        {isValidated && (
          <button
            type="button"
            className="btn-success"
            disabled={busy}
            onClick={() => act(() => client.approveSession(session.id))}
          >
            Approve
          </button>
        )}
        {isValidated && (
          <button
            type="button"
            className="btn-danger"
            disabled={busy}
            onClick={() => {
              const feedback = prompt('Rejection reason:');
              if (feedback !== null) {
                act(() => client.rejectSession(session.id, feedback));
              }
            }}
          >
            Reject
          </button>
        )}
        {canPause && (
          <button
            type="button"
            className="btn-ghost"
            disabled={busy}
            onClick={() => act(() => client.pauseSession(session.id))}
          >
            Pause
          </button>
        )}
        {isRunning && !isWorkspace && (
          <button
            type="button"
            className="btn-ghost"
            disabled={busy}
            onClick={() => {
              const msg = prompt('Nudge message:');
              if (msg) act(() => client.nudgeSession(session.id, msg));
            }}
          >
            Nudge
          </button>
        )}
        {canKill && (
          <button
            type="button"
            className="btn-danger"
            disabled={busy}
            onClick={() => {
              if (confirm('Kill this session?')) {
                act(() => client.killSession(session.id));
              }
            }}
          >
            Kill
          </button>
        )}
        {session.prUrl && (
          <a
            href={session.prUrl}
            target="_blank"
            rel="noopener noreferrer"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              padding: '6px 14px',
              background: 'var(--surface2)',
              borderRadius: 6,
              fontSize: 13,
              color: 'var(--text)',
            }}
          >
            PR →
          </a>
        )}
      </div>
    </div>
  );
}
