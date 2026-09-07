import type { ScanRepairDispatch, ScanReportDetail, ScanTriageRequest } from '@autopod/shared';
import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { apiFetch } from '../lib/api.js';

export function ScanReport() {
  const { id = '' } = useParams();
  const path = `/scan-reports/${encodeURIComponent(id)}`;
  const storageKey = `autopod-scan-triage:${id}`;
  const [detail, setDetail] = useState<ScanReportDetail | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [reason, setReason] = useState('');
  const [pending, setPending] = useState<ScanTriageRequest | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  useEffect(() => {
    let active = true;
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
    apiFetch<ScanReportDetail>(path)
      .then((value) => {
        if (active) setDetail(value);
      })
      .catch((err: Error) => {
        if (active) setError(err.message);
      });
    return () => {
      active = false;
    };
  }, [path, storageKey]);
  async function triage(action: ScanTriageRequest['action']) {
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
      setDetail(await apiFetch<ScanReportDetail>(path));
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
      setError(`${(err as Error).message}. Your decision is retained here for retry.`);
    } finally {
      setBusy(false);
    }
  }
  async function repair(selectionId: string) {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const receipt = await apiFetch<ScanRepairDispatch>(`${path}/repairs`, {
        method: 'POST',
        body: JSON.stringify({ selectionId }),
      });
      setDetail(await apiFetch<ScanReportDetail>(path));
      setMessage(`Repair pod ${receipt.podId} recorded. Delivery remains unverified.`);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }
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
      {!detail ? (
        <p>Loading report…</p>
      ) : (
        <>
          <section className="scan-card">
            <h2>{detail.report.status.replaceAll('_', ' ')}</h2>
            <p>{detail.report.createdAt} · Report completion is separate from patch delivery.</p>
            <p>
              {detail.report.policy.baseRef} → {detail.report.policy.headRef}
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
            <p>Judgment: {detail.report.judgment.status}</p>
            {detail.report.judgment.text && <p>{detail.report.judgment.text}</p>}
            {detail.report.judgment.usage && (
              <p>
                {detail.report.judgment.usage.model} ·{' '}
                {detail.report.judgment.usage.inputTokens +
                  detail.report.judgment.usage.outputTokens}{' '}
                tokens · Cost:{' '}
                {detail.report.judgment.usage.costUsd === null
                  ? 'unavailable'
                  : `$${detail.report.judgment.usage.costUsd.toFixed(4)}`}
              </p>
            )}
          </section>
          <section className="scan-card">
            <h2>Unresolved findings ({detail.unresolved.length})</h2>
            <p>
              Includes earlier findings still awaiting resolution. Selecting a repair does not mark
              it fixed.
            </p>
            {pending && (
              <output>
                A decision is retained for retry: {pending.action.replaceAll('_', ' ')}.
              </output>
            )}
            {detail.unresolved.map((finding) => (
              <label className="scan-finding" key={finding.id}>
                <input
                  type="checkbox"
                  disabled={busy}
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
                  disabled={busy || !selected.length || !reason.trim()}
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
                      disabled={busy}
                      onClick={() => void repair(decision.id)}
                    >
                      Launch selected repair
                    </button>
                  )
                )}
              </article>
            ))}
          </section>
        </>
      )}
    </main>
  );
}
