import type { AskHumanPayload, EscalationRequest } from '@autopod/shared';
import { useState } from 'react';
import { ApiError, AuthRequiredError, apiFetch } from '../lib/api.js';

interface Props {
  podId: string;
  escalation: EscalationRequest;
}

function isAskHuman(e: EscalationRequest): e is EscalationRequest & { payload: AskHumanPayload } {
  return e.type === 'ask_human';
}

export function EscalationCard({ podId, escalation }: Props): JSX.Element {
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!isAskHuman(escalation)) {
    // ask_ai / report_blocker / action_approval / validation_override / request_credential
    // are surfaced read-only on mobile — the desktop has the richer UI for them.
    return (
      <section className="escalation-card">
        <header className="escalation-header">
          <span className="chip chip-warn">awaiting input</span>
          <span className="muted">{escalation.type.replace(/_/g, ' ')}</span>
        </header>
        <p className="muted">Respond from the desktop app.</p>
      </section>
    );
  }

  const { question, context, options } = escalation.payload;

  async function answer(message: string): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await apiFetch(`/pods/${podId}/message`, {
        method: 'POST',
        body: JSON.stringify({ message }),
      });
      setValue('');
    } catch (err) {
      if (err instanceof AuthRequiredError) return;
      if (err instanceof ApiError) setError(err.message);
      else setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="escalation-card">
      <header className="escalation-header">
        <span className="chip chip-warn">awaiting input</span>
      </header>
      <p className="escalation-question">{question}</p>
      {context ? <p className="muted escalation-context">{context}</p> : null}

      {options && options.length > 0 ? (
        <div className="escalation-options">
          {options.map((option) => (
            <button
              key={option}
              type="button"
              className="action-btn action-primary"
              disabled={busy}
              onClick={() => void answer(option)}
            >
              {option}
            </button>
          ))}
        </div>
      ) : null}

      <textarea
        className="modal-textarea"
        value={value}
        placeholder="Type your answer…"
        onChange={(e) => setValue(e.target.value)}
        rows={3}
      />
      <div className="modal-actions">
        <button
          type="button"
          className="action-btn action-primary"
          disabled={busy || value.trim().length === 0}
          onClick={() => void answer(value.trim())}
        >
          {busy ? 'Sending…' : 'Send'}
        </button>
      </div>

      {error ? <div className="error">{error}</div> : null}
    </section>
  );
}
