import type {
  ScanDecisionPage,
  ScanFindingPage,
  ScanRepairDispatch,
  ScanReportDetail,
  ScanTriageRequest,
} from '@autopod/shared';
import { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { apiFetch } from '../lib/api.js';

export function ScanReport() {
  const { id = '' } = useParams();
  const path = `/scan-reports/${encodeURIComponent(id)}`;
  const storageKey = `autopod-scan-triage:${id}`;
  const viewGeneration = useRef(0);
  const [loadingPage, setLoadingPage] = useState(false);
  const [detail, setDetail] = useState<ScanReportDetail | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [reason, setReason] = useState('');
  const [pending, setPending] = useState<ScanTriageRequest | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  useEffect(() => {
    let active = true;
    const owner = ++viewGeneration.current;
    setBusy(false);
    setLoadingPage(false);
    setError('');
    setDetail(null);
    setSelected([]);
    setReason('');
    setPending(null);
    try {
      const saved = JSON.parse(
        localStorage.getItem(storageKey) ?? 'null',
      ) as ScanTriageRequest | null;
      if (
        saved?.requestKey &&
        Array.isArray(saved.findingIds) &&
        typeof saved.reason === 'string'
      ) {
        setPending(saved);
        setSelected(saved.findingIds);
        setReason(saved.reason);
      }
    } catch {
      /* A malformed local draft never grants repair authority. */
    }
    apiFetch<ScanReportDetail>(`${path}/review`)
      .then((value) => {
        if (active && owner === viewGeneration.current) setDetail(value);
      })
      .catch((err: Error) => {
        if (active) setError(err.message);
      });
    return () => {
      active = false;
      viewGeneration.current++;
    };
  }, [path, storageKey]);
  async function more(kind: 'findings' | 'decisions') {
    const cursor = kind === 'findings' ? detail?.unresolvedNextCursor : detail?.decisionsNextCursor;
    if (!cursor || busy || loadingPage) return;
    const owner = viewGeneration.current;
    setLoadingPage(true);
    setError('');
    try {
      if (kind === 'findings') {
        const page = await apiFetch<ScanFindingPage>(
          `${path}/findings?after=${encodeURIComponent(cursor)}`,
        );
        if (owner !== viewGeneration.current) return;
        setDetail((previous) =>
          previous
            ? {
                ...previous,
                diagnostics: [...(previous.diagnostics ?? []), ...(page.diagnostics ?? [])],
                unresolved: [
                  ...previous.unresolved,
                  ...page.items.filter(
                    (item) => !previous.unresolved.some((old) => old.id === item.id),
                  ),
                ],
                unresolvedNextCursor: page.nextCursor,
              }
            : previous,
        );
      } else {
        const page = await apiFetch<ScanDecisionPage>(
          `${path}/decisions?before=${encodeURIComponent(cursor)}`,
        );
        if (owner !== viewGeneration.current) return;
        setDetail((previous) =>
          previous
            ? {
                ...previous,
                diagnostics: [...(previous.diagnostics ?? []), ...(page.diagnostics ?? [])],
                decisions: [
                  ...previous.decisions,
                  ...page.items.filter(
                    (item) => !previous.decisions.some((old) => old.id === item.id),
                  ),
                ],
                decisionsNextCursor: page.nextCursor,
              }
            : previous,
        );
      }
    } catch (err) {
      if (owner === viewGeneration.current) setError((err as Error).message);
    } finally {
      if (owner === viewGeneration.current) setLoadingPage(false);
    }
  }
  async function triage(action: ScanTriageRequest['action']) {
    const owner = ++viewGeneration.current;
    setLoadingPage(false);
    setBusy(true);
    setError('');
    setMessage('');
    const findingIds = [...selected].sort();
    const same =
      pending?.action === action &&
      pending.reason === reason.trim() &&
      JSON.stringify(pending.findingIds) === JSON.stringify(findingIds);
    const request: ScanTriageRequest = same
      ? pending
      : { requestKey: crypto.randomUUID(), findingIds, reason: reason.trim(), action };
    try {
      // Save before sending. A lost response or reload can retry the same decision identity.
      localStorage.setItem(storageKey, JSON.stringify(request));
      setPending(request);
      await apiFetch(`${path}/triage`, { method: 'POST', body: JSON.stringify(request) });
      if (owner !== viewGeneration.current) return;
      const refreshed = await apiFetch<ScanReportDetail>(`${path}/review`);
      if (owner !== viewGeneration.current) return;
      setDetail(refreshed);
      localStorage.removeItem(storageKey);
      setPending(null);
      setSelected([]);
      setReason('');
      setMessage(
        action === 'select_repair'
          ? 'Selection recorded. Review it below before launching a repair.'
          : 'Decision recorded.',
      );
    } catch (err) {
      if (owner === viewGeneration.current)
        setError(`${(err as Error).message}. Your decision is retained here for retry.`);
    } finally {
      if (owner === viewGeneration.current) setBusy(false);
    }
  }
  async function repair(selectionId: string) {
    const owner = ++viewGeneration.current;
    setLoadingPage(false);
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const receipt = await apiFetch<ScanRepairDispatch>(`${path}/repairs`, {
        method: 'POST',
        body: JSON.stringify({ selectionId }),
      });
      if (owner !== viewGeneration.current) return;
      const refreshed = await apiFetch<ScanReportDetail>(`${path}/review`);
      if (owner !== viewGeneration.current) return;
      setDetail(refreshed);
      setMessage(`Repair pod ${receipt.podId} recorded. Delivery remains unverified.`);
    } catch (err) {
      if (owner === viewGeneration.current) setError((err as Error).message);
    } finally {
      if (owner === viewGeneration.current) setBusy(false);
    }
  }
  const unavailableFindings = new Set(
    detail?.diagnostics?.filter((item) => item.kind === 'finding').map((item) => item.recordId) ??
      [],
  );
  const reportUnavailable = !!detail?.report.evidenceDiagnostics?.length;
  const scopeUnavailable =
    !detail?.report.collection || detail.report.collection.repository === 'unavailable';
  return (
    <main className="scan-report">
      <Link to="/scan-reports" className="back-link">
        ← Scan reports
      </Link>
      <header className="app-header">
        <h1>Report review</h1>
      </header>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {message && <output>{message}</output>}
      {!detail || detail.report.id !== id ? (
        <p>Loading report…</p>
      ) : (
        <>
          <section className="scan-card">
            <h2>
              {reportUnavailable
                ? 'Report evidence unavailable'
                : detail.report.status.replaceAll('_', ' ')}
            </h2>
            {reportUnavailable && (
              <>
                <p>
                  Recorded status: {detail.report.status.replaceAll('_', ' ')}. A clean result
                  cannot be verified.
                </p>
                {detail.report.evidenceDiagnostics.map((message) => (
                  <p key={message}>{message}</p>
                ))}
              </>
            )}
            <p>{detail.report.createdAt} · Report completion is separate from patch delivery.</p>
            <p>
              {detail.report.policy
                ? `${detail.report.policy.baseRef} → ${detail.report.policy.headRef}`
                : 'Policy unavailable'}
            </p>
            <details>
              <summary>Exact source and files</summary>
              <p>{detail.report.collection?.repository ?? 'Repository unavailable'}</p>
              {detail.report.collection?.window && (
                <p>
                  Window: {detail.report.collection.window.start} →{' '}
                  {detail.report.collection.window.end} ·{' '}
                  {detail.report.collection.window.selectedCommits.length} first-parent commits ·
                  net delta
                </p>
              )}
              <p>Base: {detail.report.collection?.baseSha ?? 'unavailable'}</p>
              <p>Head: {detail.report.collection?.headSha ?? 'unavailable'}</p>
              {detail.report.collection?.files.map((file) => (
                <p key={file.path}>
                  {file.change}: {file.path}
                </p>
              ))}
            </details>
            {detail.report.collection?.diagnostics.map((diagnostic) => (
              <p key={diagnostic}>{diagnostic}</p>
            ))}
            {detail.report.collection?.scanners.map((scanner) => (
              <p key={scanner.scanner}>
                {scanner.scanner}: {scanner.status.replaceAll('_', ' ')} ·{' '}
                {scanner.findingCount ?? 'Unknown'} findings
                {scanner.diagnostic ? ` · ${scanner.diagnostic}` : ''}
              </p>
            ))}
            <p>Judgment: {detail.report.judgment?.status ?? 'unavailable'}</p>
            {detail.report.judgment?.text && <p>{detail.report.judgment.text}</p>}
            {detail.report.judgment?.usage && (
              <p>
                {detail.report.judgment.usage.model} ·{' '}
                {detail.report.judgment.usage.inputTokens +
                  detail.report.judgment.usage.outputTokens}{' '}
                recorded tokens · Cost:{' '}
                {detail.report.judgment.usage.costUsd === null
                  ? 'unavailable'
                  : `$${detail.report.judgment.usage.costUsd.toFixed(4)}`}
              </p>
            )}
          </section>
          {!!detail.diagnostics?.length && (
            <section className="scan-card" role="alert">
              <h2>Some review records are unavailable</h2>
              <p>
                Loaded counts exclude these records. They remain stored and have not been resolved.
              </p>
              {detail.diagnostics.map((item) => (
                <p key={`${item.kind}:${item.recordId}`}>
                  <strong>{item.recordId}</strong> · {item.message}
                </p>
              ))}
            </section>
          )}
          <section className="scan-card">
            <h2>Unresolved findings ({detail.unresolved.length} loaded)</h2>
            <p>
              Includes earlier findings still awaiting resolution. Selecting a repair does not mark
              it fixed.
            </p>
            {pending && (
              <output>
                A decision is retained for retry: {pending.action.replaceAll('_', ' ')}.
              </output>
            )}
            {selected.some((id) => unavailableFindings.has(id)) && (
              <button
                type="button"
                className="action-btn"
                disabled={busy}
                onClick={() => {
                  localStorage.removeItem(storageKey);
                  setPending(null);
                  setSelected(selected.filter((id) => !unavailableFindings.has(id)));
                  setMessage(
                    'Unavailable selections removed from this local draft. Recorded decisions remain in history.',
                  );
                }}
              >
                Remove unavailable selections
              </button>
            )}
            {detail.unresolved.map((finding) => (
              <label className="scan-finding" key={finding.id}>
                <input
                  type="checkbox"
                  disabled={
                    busy ||
                    reportUnavailable ||
                    scopeUnavailable ||
                    (selected.length >= 100 && !selected.includes(finding.id))
                  }
                  checked={selected.includes(finding.id)}
                  onChange={(event) =>
                    setSelected(
                      event.target.checked
                        ? [...selected, finding.id]
                        : selected.filter((value) => value !== finding.id),
                    )
                  }
                />
                <span>
                  <strong>
                    {finding.severity} · {finding.file}
                    {finding.line ? `:${finding.line}` : ''}
                  </strong>
                  <br />
                  {finding.summary}
                  <br />
                  <small>
                    {finding.disposition} · {finding.id}
                  </small>
                </span>
              </label>
            ))}
            {detail.unresolvedNextCursor && (
              <button
                type="button"
                className="action-btn"
                disabled={busy || loadingPage}
                onClick={() => void more('findings')}
              >
                Load more findings
              </button>
            )}
            <p>
              {selected.length} / 100 findings selected. Select up to 100 findings per decision.
            </p>
            <label className="form-row">
              Reason
              <textarea
                className="form-select"
                value={reason}
                maxLength={4000}
                disabled={busy}
                onChange={(event) => setReason(event.target.value)}
              />
            </label>
            <div className="form-actions">
              {(['defer', 'resolve', 'select_repair'] as const).map((action) => (
                <button
                  type="button"
                  className="action-btn"
                  key={action}
                  disabled={
                    busy ||
                    reportUnavailable ||
                    scopeUnavailable ||
                    !selected.length ||
                    !reason.trim() ||
                    selected.some((id) => unavailableFindings.has(id))
                  }
                  onClick={() => void triage(action)}
                >
                  {action === 'select_repair'
                    ? 'Record repair selection'
                    : action === 'resolve'
                      ? 'Record resolution'
                      : 'Defer'}
                </button>
              ))}
            </div>
          </section>
          <section className="scan-card">
            <h2>Recorded decisions</h2>
            {detail.decisions.map((decision) => (
              <article key={decision.id} className="scan-decision">
                <strong>{decision.action.replaceAll('_', ' ')}</strong>
                <p>{decision.reason}</p>
                <p>
                  {decision.findingIds.length} selected · {decision.createdAt}
                </p>
                <ul>
                  {decision.findingIds.map((findingId) => (
                    <li key={findingId}>
                      {detail.unresolved.find((finding) => finding.id === findingId)?.file ??
                        findingId}
                    </li>
                  ))}
                </ul>
                {decision.repairPodId ? (
                  <Link to={`/pod/${decision.repairPodId}`}>Repair pod {decision.repairPodId}</Link>
                ) : (
                  decision.action === 'select_repair' && (
                    <button
                      type="button"
                      className="action-btn action-primary"
                      disabled={
                        busy ||
                        reportUnavailable ||
                        scopeUnavailable ||
                        decision.findingIds.some((id) => unavailableFindings.has(id))
                      }
                      onClick={() => void repair(decision.id)}
                    >
                      Launch selected repair
                    </button>
                  )
                )}
              </article>
            ))}
            {detail.decisionsNextCursor && (
              <button
                type="button"
                className="action-btn"
                disabled={busy || loadingPage}
                onClick={() => void more('decisions')}
              >
                Load older decisions
              </button>
            )}
          </section>
        </>
      )}
    </main>
  );
}
