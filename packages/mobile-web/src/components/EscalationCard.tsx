import type {
  ActionApprovalPayload,
  AskHumanPayload,
  EscalationRequest,
  ReportBlockerPayload,
  RequestCredentialPayload,
  ValidationOverridePayload,
} from '@autopod/shared';
import { useState } from 'react';
import { ApiError, AuthRequiredError, apiFetch } from '../lib/api.js';

interface Props {
  podId: string;
  escalation: EscalationRequest;
}

function isAskHuman(e: EscalationRequest): e is EscalationRequest & { payload: AskHumanPayload } {
  return e.type === 'ask_human';
}

function isActionApproval(
  e: EscalationRequest,
): e is EscalationRequest & { payload: ActionApprovalPayload } {
  return e.type === 'action_approval';
}

function isReportBlocker(
  e: EscalationRequest,
): e is EscalationRequest & { payload: ReportBlockerPayload } {
  return e.type === 'report_blocker';
}

function isRequestCredential(
  e: EscalationRequest,
): e is EscalationRequest & { payload: RequestCredentialPayload } {
  return e.type === 'request_credential';
}

function isValidationOverride(
  e: EscalationRequest,
): e is EscalationRequest & { payload: ValidationOverridePayload } {
  return e.type === 'validation_override';
}

interface ReplyButton {
  label: string;
  message: string;
  tone?: 'primary' | 'danger';
}

interface EscalationViewModel {
  title: string;
  body: string;
  context?: string;
  options: string[];
  buttons: ReplyButton[];
  allowFreeText: boolean;
  placeholder: string;
}

function formatValue(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function formatActionParams(params: Record<string, unknown> | undefined): string {
  if (!params || Object.keys(params).length === 0) return '';
  return Object.entries(params)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}: ${formatValue(value)}`)
    .join(', ');
}

function serviceLabel(service: RequestCredentialPayload['service'] | undefined): string {
  switch (service) {
    case 'github':
      return 'GitHub';
    case 'ado':
      return 'ADO';
    default:
      return 'git provider';
  }
}

export function escalationViewModel(escalation: EscalationRequest): EscalationViewModel {
  if (isAskHuman(escalation)) {
    return {
      title: 'Agent needs input',
      body: escalation.payload.question,
      context: escalation.payload.context,
      options: escalation.payload.options ?? [],
      buttons: [],
      allowFreeText: true,
      placeholder: 'Type your answer…',
    };
  }

  if (isValidationOverride(escalation)) {
    const { attempt, maxAttempts, findings } = escalation.payload;
    const header =
      attempt && maxAttempts
        ? `Validation found ${findings.length} recurring finding(s) after ${attempt}/${maxAttempts} attempts.`
        : `Validation found ${findings.length} recurring finding(s).`;
    const list = findings.map((finding, index) => `${index + 1}. ${finding.description}`);
    const hint =
      'Reply `dismiss` to override all, `dismiss 1,3` for specific items, or any other text as guidance for the agent.';

    return {
      title: 'Agent needs input',
      body: [header, ...list, hint].join('\n\n'),
      options: [],
      buttons: [{ label: 'Dismiss all', message: 'dismiss' }],
      allowFreeText: true,
      placeholder: 'Type dismiss or guidance…',
    };
  }

  if (isActionApproval(escalation)) {
    const details = formatActionParams(escalation.payload.params);
    return {
      title: 'Action requires approval',
      body: details
        ? `Approve action: ${escalation.payload.actionName} (${details})`
        : `Approve action: ${escalation.payload.actionName}`,
      context: escalation.payload.description,
      options: [],
      buttons: [
        { label: 'Approve', message: 'approved' },
        { label: 'Reject', message: 'rejected', tone: 'danger' },
      ],
      allowFreeText: false,
      placeholder: 'Type your reply…',
    };
  }

  if (isRequestCredential(escalation)) {
    const reason = escalation.payload.reason.trim();
    return {
      title: 'Credential update required',
      body:
        reason ||
        `Credential update required for ${serviceLabel(
          escalation.payload.service,
        )}. Update the profile PAT, then reply to retry.`,
      options: [],
      buttons: [],
      allowFreeText: true,
      placeholder: 'Type your reply after updating the PAT…',
    };
  }

  if (isReportBlocker(escalation)) {
    const attempted =
      escalation.payload.attempted.length > 0
        ? `Attempted:\n${escalation.payload.attempted.map((item) => `- ${item}`).join('\n')}`
        : undefined;
    const needs = `Needs:\n${escalation.payload.needs}`;
    return {
      title: 'Agent needs input',
      body: escalation.payload.description,
      context: [attempted, needs].filter(Boolean).join('\n\n'),
      options: [],
      buttons: [],
      allowFreeText: true,
      placeholder: 'Type your reply…',
    };
  }

  return {
    title: escalation.type.replace(/_/g, ' '),
    body: 'Respond from the desktop app.',
    options: [],
    buttons: [],
    allowFreeText: false,
    placeholder: 'Type your reply…',
  };
}

export function EscalationCard({ podId, escalation }: Props): JSX.Element {
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const model = escalationViewModel(escalation);

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
        <span className="muted">{model.title}</span>
      </header>
      <div className="escalation-question">{model.body}</div>
      {model.context ? <div className="muted escalation-context">{model.context}</div> : null}

      {model.options.length > 0 ? (
        <div className="escalation-options">
          {model.options.map((option) => (
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

      {model.buttons.length > 0 ? (
        <div className="escalation-options">
          {model.buttons.map((button) => (
            <button
              key={button.message}
              type="button"
              className={`action-btn action-${button.tone === 'danger' ? 'danger' : 'primary'}`}
              disabled={busy}
              onClick={() => void answer(button.message)}
            >
              {button.label}
            </button>
          ))}
        </div>
      ) : null}

      {model.allowFreeText ? (
        <>
          <textarea
            className="modal-textarea"
            value={value}
            placeholder={model.placeholder}
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
        </>
      ) : null}

      {error ? <div className="error">{error}</div> : null}
    </section>
  );
}
