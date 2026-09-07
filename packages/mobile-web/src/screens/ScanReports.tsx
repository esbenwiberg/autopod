import type { ScheduledJob, ScheduledScanReport } from '@autopod/shared';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { apiFetch } from '../lib/api.js';

export function ScanReports() {
  const [jobs, setJobs] = useState<ScheduledJob[]>([]);
  const [reports, setReports] = useState<ScheduledScanReport[]>([]);
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
  useEffect(() => {
    let active = true;
    setReports([]);
    if (jobId)
      apiFetch<ScheduledScanReport[]>(`/scheduled-jobs/${encodeURIComponent(jobId)}/reports`)
        .then((items) => {
          if (active) setReports(items);
        })
        .catch((err: Error) => {
          if (active) setError(err.message);
        });
    return () => {
      active = false;
    };
  }, [jobId]);
  const job = jobs.find((item) => item.id === jobId);
  async function run() {
    setBusy(true);
    setError('');
    try {
      await apiFetch(`/scheduled-jobs/${encodeURIComponent(jobId)}/trigger`, { method: 'POST' });
      setReports(await apiFetch(`/scheduled-jobs/${encodeURIComponent(jobId)}/reports`));
    } catch (err) {
      setError((err as Error).message);
    } finally {
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
      <section className="pod-list" aria-label="Reports">
        {reports.map((report) => (
          <Link className="pod-card" key={report.id} to={`/scan-report/${report.id}`}>
            <strong>{report.status.replaceAll('_', ' ')}</strong>
            <p>{report.createdAt}</p>
            <p>
              {report.collection?.findings.length ?? 'Unknown'} observed findings · judgment{' '}
              {report.judgment.status}
            </p>
            <span>Review findings →</span>
          </Link>
        ))}
        {!reports.length && <p className="empty">No reports loaded.</p>}
      </section>
    </main>
  );
}
