import type {
  ArtifactManifest,
  ManagedPodEvent,
  ManagedValidationReceipt,
  SourceCandidateReceipt,
  SourceDeliveryReceipt,
  VerificationReceipt,
} from '@autopod/shared';
import { type JSX, type ReactNode, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { apiFetch, apiResponse } from '../lib/api.js';
import type { ManagedArtifactSummary, ManagedPodSummary } from '../store/managed-pods.js';
import { useManagedPodsStore } from '../store/managed-pods.js';
import { ManagedStateChip, formatBytes, formatDate } from './ManagedPods.js';

interface Detail {
  pod: ManagedPodSummary;
  validations: ManagedValidationReceipt[];
  candidates: SourceCandidateReceipt[];
  source: SourceDeliveryReceipt[];
  verification: VerificationReceipt | null;
  events: ManagedPodEvent[];
}

export function validationStatusLabel(status?: string): string {
  return status === 'disabled'
    ? 'Disabled by configuration'
    : status === 'not-requested' || !status
      ? 'Not requested'
      : status.replaceAll('-', ' ');
}

export function ManagedPodDetail(): JSX.Element {
  const { id = '' } = useParams<{ id: string }>();
  const fallback = useManagedPodsStore((state) => state.pods.find((item) => item.podId === id));
  const [fetchedDetail, setDetail] = useState<Detail | null>(null);
  const detail = fetchedDetail?.pod.podId === id ? fetchedDetail : null;
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pod = detail?.pod.podId === id ? detail.pod : fallback;
  const loading = !loaded;
  useEffect(() => {
    let disposed = false;
    let busy = false;
    setDetail(null);
    setLoaded(false);
    setError(null);
    const refresh = async () => {
      if (busy || document.hidden) return;
      busy = true;
      try {
        const result = await apiFetch<Detail>(`/managed/pods/${encodeURIComponent(id)}`);
        if (!disposed) {
          setDetail(result);
          setError(null);
        }
      } catch (error) {
        if (!disposed) setError((error as Error).message);
      } finally {
        busy = false;
        if (!disposed) setLoaded(true);
      }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 5000);
    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }, [id]);

  if (error && !pod) {
    return (
      <main>
        <BackLink />
        <div className="error" role="alert">
          {error}
        </div>
      </main>
    );
  }

  if (!pod) {
    return (
      <main>
        <BackLink />
        <p className="empty">
          {loading || !loaded ? 'Loading managed pod…' : 'Managed pod not found.'}
        </p>
      </main>
    );
  }

  return (
    <main>
      <BackLink />
      <header className="detail-header">
        <div className="managed-detail-id">{pod.podId}</div>
        <ManagedStateChip state={pod.state} />
      </header>
      <p className="muted detail-meta">Last event {formatDate(pod.lastEventAt)}</p>

      {error ? (
        <div className="error" role="alert">
          {error}
        </div>
      ) : null}

      <ManagedSection title="Identity">
        <ManagedDetailRow label="Dispatcher attempt" value={pod.dispatcherAttemptId} code />
        <ManagedDetailRow label="Profile" value={`${pod.profileId} v${pod.profileVersion}`} />
        <ManagedDetailRow label="Created" value={formatDate(pod.createdAt)} />
      </ManagedSection>

      <ManagedSection title="AutoPod validation">
        <p>{validationStatusLabel(pod.validationStatus)}</p>
        {detail?.validations.map((run) => (
          <div key={run.validationId}>
            <ManagedDetailRow label="Mode" value={run.mode} />
            <ManagedDetailRow label="Checked commit" value={run.newCommit} code />
            {run.reason && <p className="muted">{run.reason}</p>}
            <ul className="managed-list">
              {run.phases.map((phase) => (
                <li key={phase.phase}>
                  {phase.phase}: {phase.status} · {(phase.durationMs / 1000).toFixed(1)}s
                </li>
              ))}
            </ul>
          </div>
        ))}
      </ManagedSection>

      <ManagedSection title="Source delivery">
        <ManagedDetailRow
          label="Dispatcher verification"
          value={detail?.verification?.status ?? 'Not received'}
        />
        {detail?.candidates.map((candidate) => (
          <ManagedDetailRow
            key={candidate.candidateId}
            label="Candidate commit"
            value={candidate.newCommit}
            code
          />
        ))}
        {detail?.source.map((receipt) => (
          <div key={receipt.operationKey}>
            <ManagedDetailRow label={receipt.operation} value={receipt.status} />
            <ManagedDetailRow label="Branch" value={receipt.head} code />
            {receipt.pullRequestId ? (
              <ManagedDetailRow label="Draft PR" value={`#${receipt.pullRequestId}`} />
            ) : null}
          </div>
        ))}
      </ManagedSection>

      <ManagedSection title="Route">
        <ManagedDetailRow label="Provider account" value={pod.providerAccountId} />
        <ManagedDetailRow label="Model" value={pod.model} />
        <ManagedDetailRow label="Runtime" value={pod.runtime} />
        <ManagedDetailRow label="Target" value={pod.executionTarget} />
        <ManagedDetailRow label="Reasoning" value={pod.reasoning} />
      </ManagedSection>

      <ManagedSection title="Runtime evidence">
        <ManagedDetailRow label="Provider requests" value={pod.providerRequests.toLocaleString()} />
        <ManagedDetailRow
          label="Observed tokens"
          value={`${pod.consumedTokens.toLocaleString()}${pod.tokenUsageKnown ? '' : ' (incomplete)'}`}
        />
        <ManagedDetailRow label="Observed exit" value={pod.observedExit ? 'Yes' : 'No'} />
        <ManagedDetailRow label="Exit code" value={pod.exitCode?.toString() ?? '—'} />
        <ManagedDetailRow label="Cleanup" value={pod.cleanup} />
        <ManagedDetailRow label="Revoked" value={pod.revoked ? 'Yes' : 'No'} />
        <ManagedDetailRow label="Stop requested" value={pod.stopRequested ? 'Yes' : 'No'} />
      </ManagedSection>

      {pod.failure ? (
        <ManagedSection title="Latest provider failure" tone="danger">
          <ManagedDetailRow label="Phase" value={pod.failure.phase} />
          <ManagedDetailRow label="Reason" value={pod.failure.reason} />
          <ManagedDetailRow label="HTTP status" value={pod.failure.httpStatus?.toString() ?? '—'} />
        </ManagedSection>
      ) : null}

      {pod.limitations.length ? (
        <ManagedSection title="Limitations" tone="warn">
          <ul className="managed-list">
            {pod.limitations.map((limitation) => (
              <li key={limitation}>{limitation}</li>
            ))}
          </ul>
        </ManagedSection>
      ) : null}

      <ManagedSection title="Artifacts">
        {pod.artifacts.length ? (
          <div className="managed-artifacts">
            {pod.artifacts.map((artifact) => (
              <ArtifactCard key={artifact.artifactId} artifact={artifact} />
            ))}
          </div>
        ) : (
          <p className="muted managed-empty-copy">No committed or pending artifacts.</p>
        )}
      </ManagedSection>
      <ManagedSection title="Timeline">
        <ul className="managed-list">
          {detail?.events.map((event) => (
            <li key={event.eventId}>
              {formatDate(event.createdAt)} · {event.kind.replaceAll('_', ' ')}
            </li>
          ))}
        </ul>
      </ManagedSection>
    </main>
  );
}

function ArtifactCard({ artifact }: { artifact: ManagedArtifactSummary }): JSX.Element {
  const [manifest, setManifest] = useState<ArtifactManifest | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const base = `/artifacts/${encodeURIComponent(artifact.artifactId)}`;
  const act = async (download: boolean) => {
    setBusy(true);
    setError(null);
    try {
      if (!download) setManifest(await apiFetch<ArtifactManifest>(`${base}/manifest`));
      else {
        const response = await apiResponse(`${base}/download`, { method: 'POST' });
        const url = URL.createObjectURL(await response.blob());
        const link = document.createElement('a');
        link.href = url;
        link.download = `${artifact.artifactId}.tar.gz`;
        link.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      }
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="managed-artifact">
      <code>{artifact.artifactId}</code>
      <span>
        {artifact.status} · {artifact.fileCount} files · {formatBytes(artifact.totalBytes)}
      </span>
      {artifact.status === 'committed' && (
        <div>
          <button type="button" disabled={busy} onClick={() => void act(false)}>
            View manifest
          </button>{' '}
          <button type="button" disabled={busy} onClick={() => void act(true)}>
            Download
          </button>
        </div>
      )}
      {error && <p role="alert">{error}</p>}
      {manifest && (
        <div style={{ overflowWrap: 'anywhere' }}>
          <p>
            Bundle digest: <code>{manifest.bundle.sha256}</code>
          </p>
          <ul>
            {manifest.files.map((file) => (
              <li key={file.path}>
                {file.path} · {formatBytes(file.size)}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function BackLink(): JSX.Element {
  return (
    <Link to="/managed-pods" className="back-link">
      ← Managed Pods
    </Link>
  );
}

function ManagedSection({
  title,
  tone,
  children,
}: {
  title: string;
  tone?: 'danger' | 'warn';
  children: ReactNode;
}): JSX.Element {
  return (
    <section className={`managed-section${tone ? ` managed-section-${tone}` : ''}`}>
      <h2>{title}</h2>
      {children}
    </section>
  );
}

function ManagedDetailRow({
  label,
  value,
  code = false,
}: {
  label: string;
  value: string;
  code?: boolean;
}): JSX.Element {
  return (
    <div className="managed-detail-row">
      <span className="managed-detail-label">{label}</span>
      <span className={code ? 'managed-detail-value managed-code' : 'managed-detail-value'}>
        {value}
      </span>
    </div>
  );
}
