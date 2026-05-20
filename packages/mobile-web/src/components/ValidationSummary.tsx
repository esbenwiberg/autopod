import type { ValidationResult } from '@autopod/shared';

type PhaseStatus = 'pass' | 'fail' | 'skip' | 'uncertain';

interface Row {
  label: string;
  status: PhaseStatus;
  note?: string;
}

function rowsFor(result: ValidationResult): Row[] {
  const rows: Row[] = [];
  rows.push({ label: 'build', status: result.smoke.build.status });
  rows.push({ label: 'health', status: result.smoke.health.status });
  if (result.lint) rows.push({ label: 'lint', status: result.lint.status });
  if (result.sast) rows.push({ label: 'sast', status: result.sast.status });
  if (result.test) rows.push({ label: 'test', status: result.test.status });

  const failedPages = result.smoke.pages.filter((p) => p.status === 'fail').length;
  rows.push({
    label: `pages (${result.smoke.pages.length})`,
    status: failedPages > 0 ? 'fail' : 'pass',
    note: failedPages > 0 ? `${failedPages} failed` : undefined,
  });

  if (result.factValidation) {
    rows.push({ label: 'facts', status: result.factValidation.status });
  }
  if (result.taskReview) {
    rows.push({
      label: 'review',
      status: result.taskReview.status,
      note: result.taskReview.status !== 'pass' ? result.taskReview.reasoning : undefined,
    });
  } else if (result.reviewSkipReason) {
    rows.push({ label: 'review', status: 'skip', note: result.reviewSkipReason });
  }
  return rows;
}

interface Props {
  result: ValidationResult;
}

export function ValidationSummary({ result }: Props): JSX.Element {
  const rows = rowsFor(result);
  return (
    <section className="validation-summary">
      <header className="validation-header">
        <span>Validation #{result.attempt}</span>
        <span className={`chip chip-${result.overall === 'pass' ? 'ok' : 'danger'}`}>
          {result.overall}
        </span>
      </header>
      <ul className="validation-rows">
        {rows.map((row) => (
          <li key={row.label} className="validation-row">
            <span className="validation-label">{row.label}</span>
            <span className={`chip chip-${toneFor(row.status)}`}>{row.status}</span>
            {row.note ? <span className="validation-note">{row.note}</span> : null}
          </li>
        ))}
      </ul>
    </section>
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
    case 'skip':
      return 'neutral';
  }
}
