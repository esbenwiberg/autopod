import type { ScanReportPage, ScanReportSummary, ScheduledJob } from '@autopod/shared';
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { apiFetch } from '../lib/api.js';

export function ScanReports() {
  const [jobs, setJobs] = useState<ScheduledJob[]>([]);
  const [reports, setReports] = useState<ScanReportSummary[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const generation = useRef(0);
  const [refreshKey, setRefreshKey] = useState(0);
  const [loading, setLoading] = useState(false);
  const [jobId, setJobId] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let active = true;
    apiFetch<ScheduledJob[]>('/scheduled-jobs')
      .then((items) => {
        if (active) {
          setJobs(items.filter((job) => job.scan));
          setJobId(items.find((job) => job.scan)?.id ?? '');
        }
      })
      .catch((err: Error) => {
        if (active) setError(err.message);
      });
    return () => {
      active = false;
    };
  }, []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: The explicit refresh action reloads the same schedule.
  useEffect(() => {
    const owner = ++generation.current;
    setReports([]);
    setCursor(null);
    setError('');
    setLoading(false);
    if (jobId) {
      setLoading(true);
      apiFetch<ScanReportPage>(`/scheduled-jobs/${encodeURIComponent(jobId)}/report-page`)
        .then((page) => {
          if (generation.current === owner) {
            setReports(page.items);
            setCursor(page.nextCursor);
          }
        })
        .catch((err: Error) => {
          if (generation.current === owner) setError(err.message);
        })
        .finally(() => {
          if (generation.current === owner) setLoading(false);
        });
    }
    return () => {
      generation.current++;
    };
  }, [jobId, refreshKey]);
  async function older() {
    if (!cursor || loading) return;
    const owner = generation.current;
    setLoading(true);
    setError('');
    try {
      const page = await apiFetch<ScanReportPage>(
        `/scheduled-jobs/${encodeURIComponent(jobId)}/report-page?before=${encodeURIComponent(cursor)}`,
      );
      if (generation.current !== owner) return;
      setReports((previous) => [
        ...previous,
        ...page.items.filter((item) => !previous.some((old) => old.id === item.id)),
      ]);
      setCursor(page.nextCursor);
    } catch (err) {
      if (generation.current === owner) setError((err as Error).message);
    } finally {
      if (generation.current === owner) setLoading(false);
    }
  }
  const job = jobs.find((item) => item.id === jobId);
  async function run() {
    setBusy(true);
    setError('');
    const owner = ++generation.current;
    setLoading(true);
    try {
      await apiFetch(`/scheduled-jobs/${encodeURIComponent(jobId)}/trigger`, { method: 'POST' });
      const page = await apiFetch<ScanReportPage>(
        `/scheduled-jobs/${encodeURIComponent(jobId)}/report-page`,
      );
      if (generation.current === owner) {
        setReports(page.items);
        setCursor(page.nextCursor);
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      if (generation.current === owner) setLoading(false);
      setBusy(false);
    }
  }
  return (
    <main>
      <Link to="/" className="back-link">
        ← Back
      </Link>
      <header className="app-header">
        <h1>Scan reports</h1>
      </header>
      <p>
        Reports retain findings for review. A repair starts only from a recorded human selection.
      </p>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <label className="form-row">
        Report schedule
        <select
          className="form-select"
          value={jobId}
          disabled={busy}
          onChange={(event) => setJobId(event.target.value)}
        >
          <option value="">Choose a schedule</option>
          {jobs.map((item) => (
            <option key={item.id} value={item.id}>
              {item.name}
            </option>
          ))}
        </select>
      </label>
      {job?.scan && (
        <section className="scan-card">
          <p>
            {job.scan.baseRef} → {job.scan.headRef} · {job.scan.scanners.join(', ')}
          </p>
          {job.scan.windowHours && (
            <p>Last {job.scan.windowHours} hours · first-parent committer-time net delta</p>
          )}
          <p>
            {job.enabled ? 'Enabled' : 'Disabled'} · {job.cronExpression} · Judgment:{' '}
            {job.scan.judgment}
          </p>
          {job.scan.scanners.includes('dependencies') && (
            <p className="muted">
              Supported npm lockfiles are checked with the public npm advisory service.
            </p>
          )}
          {job.scan.judgment === 'bounded' && (
            <p className="muted">Judgment uses the configured provider and may incur cost.</p>
          )}
          <button type="button" className="action-btn" disabled={busy} onClick={() => void run()}>
            {busy ? 'Collecting…' : 'Collect report now'}
          </button>
        </section>
      )}
      <button
        type="button"
        className="action-btn"
        disabled={!jobId || loading || busy}
        onClick={() => setRefreshKey((value) => value + 1)}
      >
        Refresh report history
      </button>
      <section className="pod-list" aria-label="Reports">
        {reports.map((report) => (
          <Link className="pod-card" key={report.id} to={`/scan-report/${report.id}`}>
            <strong>{report.status.replaceAll('_', ' ')}</strong>
            <p>{report.createdAt}</p>
            <p>
              {report.findingCount ?? 'Unknown'} observed findings · judgment{' '}
              {report.judgmentStatus ?? 'unavailable'}
            </p>
            {report.diagnostics.map((diagnostic) => (
              <p key={diagnostic}>{diagnostic}</p>
            ))}
            <span>Review findings →</span>
          </Link>
        ))}
        {!reports.length && (
          <p className="empty">{loading ? 'Loading reports…' : 'No reports loaded.'}</p>
        )}
        {cursor && (
          <button
            type="button"
            className="action-btn"
            disabled={loading || busy}
            onClick={() => void older()}
          >
            Load older reports
          </button>
        )}
        {reports.length > 0 && !cursor && !loading && <p>End of available report history.</p>}
      </section>
    </main>
  );
}
