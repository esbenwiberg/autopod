import type { ValidationResult } from '@autopod/shared';
import type { JSX } from 'react';
import { useState } from 'react';

export interface StoredValidation {
  id: string;
  podId: string;
  attempt: number;
  sequence?: number;
  cycle?: number;
  result: ValidationResult;
  createdAt: string;
}

type PhaseStatus = 'pass' | 'fail' | 'skip' | 'uncertain' | 'pending_human';

interface Row {
  label: string;
  status: PhaseStatus;
  note?: string;
}

export function rowsFor(result: ValidationResult): Row[] {
  const rows: Row[] = [];
  if (result.infrastructureFailure) {
    rows.push({
      label: `${result.infrastructureFailure.phase} infrastructure`,
      status: 'fail',
      note: firstLine(result.infrastructureFailure.message),
    });
  }
  rows.push({
    label: 'build',
    status: result.smoke.build.status,
    note: result.smoke.build.status === 'fail' ? firstLine(result.smoke.build.output) : undefined,
  });
  rows.push({
    label: 'health',
    status: result.smoke.health.status,
    note:
      result.smoke.health.status === 'fail'
        ? result.smoke.health.responseCode
          ? `HTTP ${result.smoke.health.responseCode}`
          : result.smoke.health.url
        : undefined,
  });
  if (result.lint) {
    rows.push({
      label: 'lint',
      status: result.lint.status,
      note: result.lint.reusedEvidence
        ? `Reused ${result.lint.reusedEvidence.receiptId}; executed ${result.lint.reusedEvidence.originalExecutedAt}`
        : result.lint.status === 'fail'
          ? firstLine(result.lint.output)
          : undefined,
    });
  }
  if (result.sast) {
    rows.push({
      label: 'sast',
      status: result.sast.status,
      note: result.sast.status === 'fail' ? firstLine(result.sast.output) : undefined,
    });
  }
  if (result.test) {
    rows.push({
      label: 'test',
      status: result.test.status,
      note: result.test.reusedEvidence
        ? `Reused ${result.test.reusedEvidence.receiptId}; executed ${result.test.reusedEvidence.originalExecutedAt}`
        : result.test.status === 'fail'
          ? firstLine(result.test.stderr ?? result.test.stdout ?? '')
          : undefined,
    });
  }

  const failedPages = result.smoke.pages.filter((p) => p.status === 'fail').length;
  rows.push({
    label: `pages (${result.smoke.pages.length})`,
    status: result.smoke.pages.length === 0 ? 'skip' : failedPages > 0 ? 'fail' : 'pass',
    note:
      result.smoke.pages.length === 0
        ? 'No page checks executed'
        : failedPages > 0
          ? `${failedPages} failed`
          : undefined,
  });

  if (result.factValidation) {
    const failedFacts = result.factValidation.results.filter((fact) => !fact.passed).length;
    rows.push({
      label: 'facts',
      status: result.factValidation.status,
      note: failedFacts > 0 ? `${failedFacts} failed` : undefined,
    });
  }
  if (result.taskReview) {
    rows.push({
      label: 'review',
      status: result.taskReview.status,
      note:
        result.taskReview.status !== 'pass'
          ? (result.taskReview.issues[0] ?? firstLine(result.taskReview.reasoning))
          : undefined,
    });
  } else if (result.reviewSkipReason) {
    rows.push({ label: 'review', status: 'skip', note: result.reviewSkipReason });
  }
  return rows;
}

interface Props {
  result?: ValidationResult | null;
  history?: StoredValidation[];
}

interface ValidationDisplayItem {
  id: string;
  sequence?: number;
  cycle?: number;
  source: 'history' | 'latest';
  createdAt: string;
  result: ValidationResult;
}

export function ValidationSummary({ result = null, history = [] }: Props): JSX.Element | null {
  const items = validationItemsForDisplay(history, result);
  const [showPrevious, setShowPrevious] = useState(false);
  if (items.length === 0) return null;

  const latest = items[0];
  const previous = items.slice(1);
  const visibleItems = showPrevious ? items : latest ? [latest] : [];

  return (
    <section className="validation-summary">
      <h2>Validation results</h2>
      <div className="validation-attempts">
        {visibleItems.map((item) => (
          <ValidationAttempt key={item.id} item={item} />
        ))}
      </div>
      {previous.length > 0 ? (
        <button
          type="button"
          className="validation-history-toggle"
          onClick={() => setShowPrevious((current) => !current)}
        >
          {showPrevious
            ? 'Hide previous attempts'
            : `Show previous ${previous.length} attempt${previous.length === 1 ? '' : 's'}`}
        </button>
      ) : null}
    </section>
  );
}

export function validationItemsForDisplay(
  history: StoredValidation[],
  latest: ValidationResult | null,
): ValidationDisplayItem[] {
  const canonical = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === 'object')
      return Object.fromEntries(
        Object.entries(value)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, child]) => [key, canonical(child)]),
      );
    return value;
  };
  const items: ValidationDisplayItem[] = history.map((item) => ({
    id: item.id,
    sequence: item.sequence,
    cycle: item.cycle,
    source: 'history',
    createdAt: item.createdAt,
    result: item.result,
  }));
  // Never replace a durable failure using a mutable display-attempt number.
  if (
    latest &&
    !history.some(
      (item) => JSON.stringify(canonical(item.result)) === JSON.stringify(canonical(latest)),
    )
  ) {
    items.push({
      id: `latest-${latest.timestamp}-${latest.attempt}`,
      source: 'latest',
      createdAt: latest.timestamp,
      result: latest,
    });
  }
  return items.sort((a, b) => {
    if (a.source !== b.source) return a.source === 'latest' ? -1 : 1;
    if (a.sequence !== undefined && b.sequence !== undefined) return b.sequence - a.sequence;
    return b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id);
  });
}

function ValidationAttempt({ item }: { item: ValidationDisplayItem }): JSX.Element {
  const { result } = item;
  const rows = rowsFor(result);
  return (
    <article className="validation-attempt">
      <header className="validation-header">
        <div>
          <div className="validation-title">Validation #{item.sequence ?? result.attempt}</div>
          <div className="validation-meta">
            {shortDateTime(item.createdAt)} · {formatDuration(result.duration)}
            {item.source === 'latest'
              ? ' · Latest snapshot; durable record unavailable or different'
              : item.sequence === undefined
                ? ' · Legacy attempt number'
                : ` · Attempt ${result.attempt}, cycle ${(item.cycle ?? 0) + 1}`}
          </div>
        </div>
        <span className={`chip chip-${result.overall === 'pass' ? 'ok' : 'danger'}`}>
          {result.overall}
        </span>
      </header>
      <ul className="validation-rows">
        {rows.map((row) => (
          <li key={row.label} className="validation-row">
            <span className="validation-label">{row.label}</span>
            <span className={`chip chip-${toneFor(row.status)}`}>{labelForStatus(row.status)}</span>
            {row.note ? <span className="validation-note">{row.note}</span> : null}
          </li>
        ))}
      </ul>
    </article>
  );
}

function toneFor(status: PhaseStatus): 'ok' | 'danger' | 'neutral' | 'warn' {
  switch (status) {
    case 'pass':
      return 'ok';
    case 'fail':
      return 'danger';
    case 'uncertain':
      return 'warn';
    case 'pending_human':
      return 'warn';
    case 'skip':
      return 'neutral';
  }
}

function labelForStatus(status: PhaseStatus): string {
  return status === 'pending_human' ? 'pending' : status;
}

function firstLine(text: string): string | undefined {
  const line = text
    .split(/\r?\n/)
    .map((item) => item.trim())
    .find(Boolean);
  if (!line) return undefined;
  return line.length > 96 ? `${line.slice(0, 95).trimEnd()}...` : line;
}

function formatDuration(durationMs: number): string {
  if (durationMs < 1000) return `${durationMs} ms`;
  if (durationMs < 60_000) return `${Math.round(durationMs / 100) / 10} s`;
  return `${Math.round(durationMs / 60_000)} min`;
}

function shortDateTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}
